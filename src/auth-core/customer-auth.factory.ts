import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import * as argon2 from 'argon2';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Name of the customer session cookie (AD-28). */
export const CUSTOMER_SESSION_COOKIE = 'cc_session';
/** 7 days. */
export const CUSTOMER_SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
/** Sliding window: a session older than 1 day is extended on use. */
export const CUSTOMER_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

/**
 * Story 12.3 (AD-26/AD-28): the BetterAuth instance for the CUSTOMER domain.
 * Used strictly as an internal library (`auth.api.*` from thin Nest
 * services); its HTTP handler is never mounted.
 *
 * - Own tables (`Customer*`), own secret (`CUSTOMER_AUTH_SECRET`) and own
 *   cookie prefix, so nothing signed by the admin instance verifies here and
 *   vice versa (FR-41).
 * - NO `bearer` plugin: `Authorization: Bearer` stays reserved for the
 *   admin token and the guest `orderAccessToken`. The session travels only
 *   in the httpOnly cookie `cc_session`.
 * - `autoSignIn:false`: registering never starts a session.
 * - Password reset (Story 12.4): BetterAuth's one-time token (row in
 *   `Customer_Verifications`, 1 h, deleted on use) and
 *   `revokeSessionsOnPasswordReset`. Email verification is NOT BetterAuth's
 *   stateless JWT (it could not be single-use): it is ours, see
 *   `CustomerAuthService`.
 */
export function createCustomerAuth(
  prisma: PrismaService,
  secret: string,
  options: {
    secureCookies: boolean;
    /** Story 12.4: best-effort reset email (must never throw/await long). */
    sendResetPassword: (
      user: { email: string; name: string },
      token: string,
    ) => void;
  },
) {
  return betterAuth({
    appName: '212CollectorsClub',
    baseURL: 'http://localhost',
    secret,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    user: {
      modelName: 'customer',
      additionalFields: {
        phone: { type: 'string', required: false, input: false },
      },
    },
    session: {
      modelName: 'customerSession',
      expiresIn: CUSTOMER_SESSION_EXPIRES_IN_SECONDS,
      updateAge: CUSTOMER_SESSION_UPDATE_AGE_SECONDS,
    },
    account: { modelName: 'customerAccount' },
    verification: {
      modelName: 'customerVerification',
      // Reset tokens are stored as SHA-256, never in clear.
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) => {
        options.sendResetPassword(user, token);
        return Promise.resolve();
      },
      password: {
        hash: (password: string) =>
          argon2.hash(password, { type: argon2.argon2id }),
        verify: ({ hash, password }: { hash: string; password: string }) =>
          argon2.verify(hash, password),
      },
    },
    advanced: {
      cookiePrefix: 'customer',
      useSecureCookies: options.secureCookies,
      cookies: {
        session_token: {
          name: CUSTOMER_SESSION_COOKIE,
          attributes: {
            httpOnly: true,
            sameSite: 'lax',
            secure: options.secureCookies,
            path: '/',
          },
        },
      },
      database: { generateId: 'uuid' },
    },
    // No HTTP handler is mounted, so BetterAuth's own limiter is moot; the
    // routes are throttled per IP by Nest's ThrottlerGuard instead.
    rateLimit: { enabled: false },
  });
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;
