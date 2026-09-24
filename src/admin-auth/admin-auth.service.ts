import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AdminJwtPayload } from './admin-jwt.strategy.js';
import type { AdminLoginResponseDto } from './dto/admin-login-response.dto.js';

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

    const payload: AdminJwtPayload = { sub: admin.id };
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
}
