import { createHmac } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { AdminAuth } from '../auth-core/admin-auth.factory.js';
import {
  ADMIN_SESSION_EXPIRES_IN_SECONDS,
  sessionTokenFromBearer,
} from '../auth-core/admin-auth.factory.js';
import { ADMIN_AUTH } from '../auth-core/auth-core.constants.js';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RequestContext } from '../common/request-context.js';
import { IdDocCryptoService } from '../crypto/id-doc-crypto.service.js';
import { AdminLoginFailureSummary } from './admin-login-failure-summary.js';
import { AdminLoginLimiter } from './admin-login-limiter.js';
import type { AdminLoginResponseDto } from './dto/admin-login-response.dto.js';

function invalidAdminTokenException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_ADMIN_TOKEN',
    'This route requires a valid Admin session, sent as "Authorization: Bearer <token>" from POST /api/v1/admin/auth/login.',
  );
}

/**
 * Story 7.1 (AD-11, NFR-4). `login` is the only place this codebase ever
 * compares an Admin-supplied password against `AdminUser.passwordHash`.
 *
 * **Non-enumeration, and why a dummy Argon2 verify**: the AC requires that
 * "user doesn't exist" and "user exists, wrong password" produce the exact
 * same response — same status, same errorCode, same message
 * (`invalidCredentialsException()` below is thrown from both branches,
 * never a different one per branch, so that much is enumeration-safe by
 * construction regardless of timing). What is NOT safe by construction is
 * *how long* each branch takes: skipping the Argon2 verify entirely when no
 * AdminUser matches would make that branch dramatically faster than the
 * "found, hash mismatch" branch (Argon2id is deliberately slow — tens of
 * milliseconds), and that latency gap is itself an oracle an attacker can
 * use to enumerate valid usernames/emails without ever seeing a different
 * response body (the same class of side-channel `common/order-access-
 * token.ts`'s `timingSafeEqualHex` closes for a different comparison).
 * `DUMMY_PASSWORD_HASH` is a fixed, hardcoded Argon2id digest of a
 * throwaway string — not a secret, never any real Admin's hash — so the
 * "not found" branch still pays the exact same Argon2 verify cost as the
 * "found" branch before rejecting.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$NASifCaMJ81ZVcqOdFAFiQ$fSbNpLKS8/qiuMqbdE1MxZ7DXKIK4IO+76UJFkrlpxc';

function invalidCredentialsException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_ADMIN_CREDENTIALS',
    'Incorrect username/email or password.',
  );
}

const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * Story 7.1 / 12.2 (AD-11, AD-27, NFR-4): facade over the BetterAuth admin
 * instance that keeps the exact HTTP contract of `/admin/auth/*`.
 *
 * **Non-enumeration**: unknown user and wrong password both throw the same
 * `invalidCredentialsException()`. For an unknown user a dummy Argon2id
 * verify runs so both branches cost about the same (existing users get the
 * real verify against their stored digest).
 *
 * **Lazy provisioning**: an admin that has a legacy `passwordHash` but no
 * credential `AdminAccount` with a password (fixtures, admins created after
 * the migration backfill) gets one copied from `passwordHash` before the
 * sign-in. Idempotent and race-safe (P2002 = someone else created it).
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_AUTH) private readonly adminAuth: AdminAuth,
    private readonly audit: AuditService,
    private readonly crypto: IdDocCryptoService,
    private readonly limiter: AdminLoginLimiter,
    private readonly summary: AdminLoginFailureSummary,
  ) {}

  /**
   * Story 20.5 (AD-99, A104, R4).
   *  - 429 (per IP / per IP+user failure limits, `AdminLoginLimiter`) before any hashing.
   *  - `LOGIN_ADMIN_OK` is FAIL-CLOSED: the session is created first (BetterAuth uses its own
   *    connection, so it cannot share our transaction), then the event is written in its own
   *    short audit transaction; if that fails the session is deleted (compensation) and the
   *    answer is the 503 `AUDIT_UNAVAILABLE`, never a token without an audit trail.
   *  - `LOGIN_ADMIN_FAILED` is BEST-EFFORT: scheduled after the verdict, NOT awaited, so the
   *    401 never waits for the chain-head lock and its timing is the same for a known and an
   *    unknown user (no oracle); a failure is only logged. It carries `emailHash`, never the
   *    value typed.
   */
  async login(
    usernameOrEmail: string,
    password: string,
  ): Promise<AdminLoginResponseDto> {
    const ip = RequestContext.ip();
    this.limiter.assertAllowed(ip, usernameOrEmail);
    const admin = await this.prisma.adminUser.findFirst({
      where: {
        OR: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
      },
      select: { id: true, passwordHash: true },
    });

    if (!admin) {
      await argon2.verify(DUMMY_PASSWORD_HASH, password);
      this.failed(ip, usernameOrEmail, null);
      throw invalidCredentialsException();
    }

    const storedHash = await this.ensureCredentialAccount(
      admin.id,
      admin.passwordHash,
    );

    // The user was resolved above with the exact username-OR-email lookup of
    // Story 7.1. `signInEmail` is NOT used because BetterAuth lowercases the
    // email and re-queries it, which would reject admins whose stored email
    // has uppercase characters. Instead: verify the Argon2id digest here and
    // create the BetterAuth session directly, signing the token exactly as
    // the bearer plugin / `set-auth-token` does (`<token>.<base64 HMAC>`).
    const passwordMatches = await argon2.verify(storedHash, password);
    if (!passwordMatches) {
      this.failed(ip, usernameOrEmail, admin.id);
      throw invalidCredentialsException();
    }
    const ctx = await this.adminAuth.$context;
    const session = await ctx.internalAdapter.createSession(admin.id);
    try {
      await this.audit.transaction((_tx, audit) => {
        audit.add({
          actorType: 'ADMIN',
          actorId: admin.id,
          action: 'LOGIN_ADMIN_OK',
          entityType: 'AdminUser',
          entityId: admin.id,
          after: {
            adminId: admin.id,
            method: 'password',
            sessionId: session.id,
          },
        });
        return Promise.resolve();
      });
    } catch (err) {
      await this.prisma.adminSession
        .deleteMany({ where: { token: session.token } })
        .catch((delErr: unknown) => {
          this.logger.error(
            `Could not remove admin session after an audit failure: ${String(delErr)}`,
          );
        });
      throw err;
    }
    this.limiter.recordSuccess(ip, usernameOrEmail);
    const signature = createHmac('sha256', ctx.secret)
      .update(session.token)
      .digest('base64');
    const accessToken = `${session.token}.${signature}`;

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ADMIN_SESSION_EXPIRES_IN_SECONDS,
    };
  }

  /**
   * Deletes the session behind the (already guard-verified) bearer token.
   * `deleteMany` makes it idempotent: a concurrent logout that already
   * removed the row is not an error (never a 500).
   *
   * Story 20.5: `LOGOUT_ADMIN` goes in the same transaction as the revocation, so normally the
   * event exists exactly when the row was removed. But a logout REDUCES exposure (the session
   * lives up to 8 h): it must never be refused because the audit log is down. If the audit
   * transaction fails for any reason the session is revoked anyway (plain delete), the failure is
   * logged with `logger.error` and the answer is the normal 204.
   */
  async logout(rawToken: string): Promise<void> {
    const sessionToken = sessionTokenFromBearer(rawToken);
    if (!sessionToken) {
      throw invalidAdminTokenException();
    }
    try {
      await this.audit.transaction(async (tx, audit) => {
        const rows = await tx.$queryRaw<
          { id: string; userId: string }[]
        >`DELETE FROM "Admin_Sessions" WHERE "token" = ${sessionToken} RETURNING "id", "userId"`;
        if (rows.length === 0) return;
        audit.add({
          actorType: 'ADMIN',
          actorId: rows[0].userId,
          action: 'LOGOUT_ADMIN',
          entityType: 'AdminUser',
          entityId: rows[0].userId,
          after: { adminId: rows[0].userId, sessionId: rows[0].id },
        });
      });
    } catch (err) {
      this.logger.error(
        `LOGOUT_ADMIN could not be audited; revoking the session anyway: ${String(err)}`,
      );
      await this.prisma.adminSession.deleteMany({
        where: { token: sessionToken },
      });
    }
  }

  /**
   * Counts the failure and schedules the best-effort `LOGIN_ADMIN_FAILED` (never awaited, never
   * throws). `adminId` is null when no admin matched; the typed value is only ever hashed.
   * A failure the budget (or a write error) leaves out is counted by `AdminLoginFailureSummary`,
   * which writes ONE `LOGIN_ADMIN_FAILED_SUMMARY` per minute at most.
   */
  private failed(
    ip: string | null,
    identifier: string,
    adminId: string | null,
  ): void {
    this.limiter.recordFailure(ip, identifier);
    let emailHash: string;
    try {
      emailHash = this.crypto.hashEmail(identifier);
    } catch (err) {
      this.logger.error(`LOGIN_ADMIN_FAILED not written: ${String(err)}`);
      this.summary.noteDropped(null, ip);
      return;
    }
    const release = this.limiter.tryAcquireEventSlot();
    if (!release) {
      this.logger.warn(
        `LOGIN_ADMIN_FAILED not written (event budget exhausted; ${this.limiter.droppedEvents} dropped since boot)`,
      );
      this.summary.noteDropped(emailHash, ip);
      return;
    }
    const hash = emailHash;
    const ctx = RequestContext.get();
    void this.audit
      .transaction((_tx, audit) => {
        audit.add({
          actorType: 'ANON',
          actorId: null,
          action: 'LOGIN_ADMIN_FAILED',
          entityType: 'AdminUser',
          entityId: adminId ?? `unknown:${hash.slice(0, 16)}`,
          after: {
            emailHash: hash,
            reason: adminId ? 'BAD_PASSWORD' : 'UNKNOWN_USER',
            adminFound: adminId !== null,
          },
          // The request context is lost once the response is sent: carry it explicitly.
          requestId: ctx?.requestId ?? null,
          ip: ctx?.ip ?? null,
        });
        return Promise.resolve();
      })
      .catch((err: unknown) => {
        this.logger.error(
          `LOGIN_ADMIN_FAILED could not be written (the 401 was already sent): ${String(err)}`,
        );
        this.summary.noteDropped(hash, ip);
      })
      .finally(release);
  }

  private async ensureCredentialAccount(
    userId: string,
    passwordHash: string,
  ): Promise<string> {
    const existing = await this.prisma.adminAccount.findFirst({
      where: { userId, providerId: CREDENTIAL_PROVIDER_ID },
      select: { password: true },
    });
    if (existing?.password) {
      return existing.password;
    }
    try {
      if (existing) {
        await this.prisma.adminAccount.updateMany({
          where: {
            userId,
            providerId: CREDENTIAL_PROVIDER_ID,
            password: null,
          },
          data: { password: passwordHash },
        });
      } else {
        await this.prisma.adminAccount.create({
          data: {
            userId,
            accountId: userId,
            providerId: CREDENTIAL_PROVIDER_ID,
            password: passwordHash,
          },
        });
      }
    } catch (err) {
      // P2002: a concurrent login provisioned it first — same outcome.
      const isRace =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002';
      if (!isRace) {
        throw err;
      }
    }
    return passwordHash;
  }
}
