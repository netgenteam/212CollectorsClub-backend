import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins/bearer';
import * as argon2 from 'argon2';
import type { PrismaService } from '../prisma/prisma.service.js';

/** 8h, matching the Admin session lifetime promised since AD-11 (Story 7.1). */
export const ADMIN_SESSION_EXPIRES_IN_SECONDS = 8 * 60 * 60;

/**
 * Story 12.2 (AD-25/26/27): the BetterAuth instance for the ADMIN domain.
 * Used strictly as an internal library (`auth.api.*` from thin Nest
 * services); its HTTP handler is never mounted.
 *
 * - Tables: `AdminUser` (`Admin_Users`, `name` <- `username`),
 *   `AdminSession`, `AdminAccount`.
 * - Passwords: Argon2id with the same parameters the seed always used, so
 *   existing digests keep verifying.
 * - Session: fixed 8h, no sliding refresh. The `bearer` plugin exposes the
 *   signed session token as `set-auth-token`; that value is the
 *   `accessToken` of `POST /admin/auth/login`.
 */
export function createAdminAuth(prisma: PrismaService, secret: string) {
  return betterAuth({
    appName: '212CollectorsClub Admin',
    baseURL: 'http://localhost',
    secret,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    user: {
      modelName: 'adminUser',
      fields: { name: 'username' },
      additionalFields: {
        roleTier: { type: 'string', required: false, input: false },
      },
    },
    session: {
      modelName: 'adminSession',
      expiresIn: ADMIN_SESSION_EXPIRES_IN_SECONDS,
      disableSessionRefresh: true,
    },
    account: { modelName: 'adminAccount' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      password: {
        hash: (password: string) =>
          argon2.hash(password, { type: argon2.argon2id }),
        verify: ({ hash, password }: { hash: string; password: string }) =>
          argon2.verify(hash, password),
      },
    },
    advanced: {
      cookiePrefix: 'admin',
      database: {
        generateId: 'uuid',
        // AD-26: the admin instance has no verification/reset flows, hence no
        // `verification` table. BetterAuth's startup schema check would flag
        // that one table as missing; the tables it does use are covered by
        // the migration + e2e (session/account rows are really read/written).
        validateSchema: false,
      },
    },
    // No HTTP handler is mounted, so BetterAuth's own limiter is moot.
    rateLimit: { enabled: false },
    plugins: [bearer({ requireSignature: true })],
  });
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;

/**
 * The signed bearer value is `<sessionToken>.<signature>` (possibly
 * URL-encoded). Returns the raw session token, or null when malformed.
 * Only call it after the value has been verified by `getSession`.
 */
export function sessionTokenFromBearer(bearerValue: string): string | null {
  let value = bearerValue;
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  const dot = value.indexOf('.');
  return dot > 0 ? value.slice(0, dot) : null;
}
