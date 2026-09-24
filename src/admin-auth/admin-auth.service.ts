import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AdminJwtPayload } from './admin-jwt.strategy.js';
import type { AdminLoginResponseDto } from './dto/admin-login-response.dto.js';

function invalidAdminTokenException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_ADMIN_TOKEN',
    'This route requires a valid Admin session, sent as "Authorization: Bearer <token>" from POST /api/v1/admin/auth/login.',
  );
}

/** 8h, matching AD-11's JWT max-age exactly — expressed once here (both as
 * the `@nestjs/jwt` sign option and the `expiresIn` echoed in the login
 * response) instead of two independently-maintained literals. */
const ADMIN_JWT_EXPIRES_IN_SECONDS = 8 * 60 * 60;

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

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(
    usernameOrEmail: string,
    password: string,
  ): Promise<AdminLoginResponseDto> {
    const admin = await this.prisma.adminUser.findFirst({
      where: {
        OR: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
      },
      select: { id: true, passwordHash: true },
    });

    // Always run a real Argon2id verify — against the real hash when the
    // AdminUser exists, against the fixed dummy hash when it doesn't — so
    // both branches below reject on the exact same code path with the
    // exact same latency profile. See this class's own doc comment.
    const passwordMatches = await argon2.verify(
      admin ? admin.passwordHash : DUMMY_PASSWORD_HASH,
      password,
    );

    if (!admin || !passwordMatches) {
      throw invalidCredentialsException();
    }

    // Story 7.2 (AD-11): a fresh, random jti per issued token — this
    // token's own revocable identity, independent of `sub` (see
    // `AdminJwtPayload`'s own doc comment for why).
    const payload: AdminJwtPayload = { sub: admin.id, jti: randomUUID() };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('ADMIN_JWT_SECRET'),
      expiresIn: ADMIN_JWT_EXPIRES_IN_SECONDS,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ADMIN_JWT_EXPIRES_IN_SECONDS,
    };
  }

  /**
   * Story 7.2 (AD-11, FR-21). `rawToken` is the exact Bearer token string
   * `POST /admin/auth/logout` was called with — by the time this runs,
   * `AdminAuthGuard` has already verified its signature and expiry (this
   * route is itself guard-gated, see `AdminAuthController`), so this only
   * needs to `decode` it (no secret, no re-verification) to recover the
   * `jti`/`exp` claims to persist.
   *
   * **Double-logout decision**: a second logout call for the SAME token,
   * in the normal sequential case, never reaches this method at all — once
   * the first call's `RevokedToken` row exists, `AdminJwtStrategy`
   * rejects the token at the guard with the same 401 `INVALID_ADMIN_TOKEN`
   * every other revoked/expired/malformed token gets (no special
   * "already logged out" status — consistent with this module's existing
   * non-enumeration posture: the caller never learns *why* their token
   * was rejected). `upsert` (not `create`) exists for the genuine race —
   * two requests for the same still-valid token landing concurrently
   * before either write commits, both passing the guard's revocation check.
   *
   * **QA fix (Story 7.2, 2nd review pass)**: `upsert` alone does NOT make
   * that race safe. Under Prisma 7.10.0 + `@prisma/adapter-pg`, `upsert`
   * is not atomic against another truly-concurrent `upsert`/`create` for
   * the same PK — both requests can read "no row exists" before either
   * commits, so both take the `create` branch; the DB's own unique
   * constraint (correctly) allows only one to land, and the loser gets a
   * `PrismaClientKnownRequestError` (code `P2002`) instead of silently
   * resolving. QA reproduced this with genuinely parallel (not sequential)
   * curl logout pairs and saw a raw 500 on the losing request 4/5 times.
   * The `catch` below is what actually makes the race a no-op: a P2002
   * here means "another concurrent request already revoked this exact
   * jti" (the winning write's data is what we wanted anyway — the row
   * exists, this jti is revoked, mission accomplished), so it's swallowed
   * and treated as success. `upsert` is kept (not swapped for a plain
   * `create`) since it's still the right shape for the common case where
   * the row doesn't exist yet, and it's harmless — the `catch` is the only
   * piece that was actually missing. Any other error (bad connection,
   * schema drift, a different constraint) still propagates untouched.
   */
  async logout(rawToken: string): Promise<void> {
    const decoded = this.jwtService.decode<
      (AdminJwtPayload & { exp?: number }) | null
    >(rawToken);

    // Unreachable in practice — AdminAuthGuard already verified this exact
    // token before this method is ever called — but guarded anyway so a
    // future refactor that loosens that guarantee fails closed instead of
    // writing a garbage RevokedToken row.
    if (
      !decoded ||
      typeof decoded.jti !== 'string' ||
      decoded.jti.length === 0 ||
      typeof decoded.exp !== 'number'
    ) {
      throw invalidAdminTokenException();
    }

    try {
      await this.prisma.revokedToken.upsert({
        where: { jti: decoded.jti },
        create: { jti: decoded.jti, expiresAt: new Date(decoded.exp * 1000) },
        update: {},
      });
    } catch (err) {
      // P2002 = unique constraint violation on `jti` (the PK): a genuinely
      // concurrent logout for this same token already won the race and
      // inserted the row first. That's the exact outcome we want (jti is
      // revoked either way), so treat it as success. Anything else
      // (connection errors, unexpected schema issues, etc.) is a real
      // failure and must keep propagating.
      const isConcurrentDuplicateRevoke =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002';
      if (!isConcurrentDuplicateRevoke) {
        throw err;
      }
    }
  }
}
