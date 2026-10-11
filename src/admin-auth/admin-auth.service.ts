import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import type { AdminAuth } from '../auth-core/admin-auth.factory.js';
import {
  ADMIN_SESSION_EXPIRES_IN_SECONDS,
  sessionTokenFromBearer,
} from '../auth-core/admin-auth.factory.js';
import { ADMIN_AUTH } from '../auth-core/auth-core.constants.js';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
 * verify runs so both branches cost about the same (BetterAuth performs the
 * real verify for existing users).
 *
 * **Lazy provisioning**: an admin that has a legacy `passwordHash` but no
 * credential `AdminAccount` with a password (fixtures, admins created after
 * the migration backfill) gets one copied from `passwordHash` before the
 * sign-in. Idempotent and race-safe (P2002 = someone else created it).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_AUTH) private readonly adminAuth: AdminAuth,
  ) {}

  async login(
    usernameOrEmail: string,
    password: string,
  ): Promise<AdminLoginResponseDto> {
    const admin = await this.prisma.adminUser.findFirst({
      where: {
        OR: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
      },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!admin) {
      await argon2.verify(DUMMY_PASSWORD_HASH, password);
      throw invalidCredentialsException();
    }

    await this.ensureCredentialAccount(admin.id, admin.passwordHash);

    let accessToken: string | null;
    try {
      const { headers } = await this.adminAuth.api.signInEmail({
        body: { email: admin.email, password },
        returnHeaders: true,
      });
      accessToken = headers.get('set-auth-token');
    } catch (err) {
      if (err instanceof APIError) {
        throw invalidCredentialsException();
      }
      throw err;
    }
    if (!accessToken) {
      throw invalidCredentialsException();
    }

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
   */
  async logout(rawToken: string): Promise<void> {
    const sessionToken = sessionTokenFromBearer(rawToken);
    if (!sessionToken) {
      throw invalidAdminTokenException();
    }
    await this.prisma.adminSession.deleteMany({
      where: { token: sessionToken },
    });
  }

  private async ensureCredentialAccount(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    const existing = await this.prisma.adminAccount.findFirst({
      where: { userId, providerId: CREDENTIAL_PROVIDER_ID },
      select: { password: true },
    });
    if (existing?.password) {
      return;
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
  }
}
