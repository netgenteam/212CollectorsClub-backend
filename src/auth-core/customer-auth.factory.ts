import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import * as argon2 from 'argon2';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** The root client, or the transaction client of one transaction (Story 20.6a, second round). */
export type CustomerAuthDb = PrismaService | Prisma.TransactionClient;

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
  prisma: CustomerAuthDb,
  secret: string,
  options: {
    secureCookies: boolean;
    /**
     * Story 20.6a: a transaction-bound instance (see `CUSTOMER_AUTH_IN_TX`) gets the result of the
     * Argon2id work computed BEFORE the transaction opened, so the transaction holds its connection
     * for statements only, never for CPU work.
     */
    password?: {
      hash?: (password: string) => Promise<string>;
      verify?: (data: { hash: string; password: string }) => Promise<boolean>;
    };
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
    // A transaction client has no `$transaction`: the adapter then runs on the very connection of the
    // transaction (`inTransaction || typeof db.$transaction !== 'function'`).
    database: prismaAdapter(prisma as PrismaService, {
      provider: 'postgresql',
    }),
    user: {
      modelName: 'customer',
      additionalFields: {
        phone: { type: 'string', required: false, input: false },
        // Story 20.6: read-only here. Returned with every session so the guard can refuse the
        // session of an anonymized account without one more query per request.
        anonymizedAt: { type: 'date', required: false, input: false },
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
        hash:
          options.password?.hash ??
          ((password: string) =>
            argon2.hash(password, { type: argon2.argon2id })),
        verify:
          options.password?.verify ??
          (({ hash, password }: { hash: string; password: string }) =>
            argon2.verify(hash, password)),
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

/**
 * Story 20.6a (second round): builds a BetterAuth instance whose every statement runs on `tx`.
 * Creating one costs ~0.4 ms. It exists so that a BetterAuth write that must be atomic with a lock on
 * the account (`forgot-password`, `reset-password`, `login`) uses the connection the transaction
 * already holds: a BetterAuth call on the ROOT client from inside a transaction needs a SECOND pooled
 * connection, and 10 such transactions exhaust a pool of 10 (every one waits for a connection that
 * only another one can free). Mail is never sent from here: the caller collects it and sends it after
 * the commit (`onResetMail`).
 */
export type CustomerAuthInTx = (
  tx: Prisma.TransactionClient,
  opts?: {
    onResetMail?: (
      user: { email: string; name: string },
      token: string,
    ) => void;
    password?: {
      hash?: (password: string) => Promise<string>;
      verify?: (data: { hash: string; password: string }) => Promise<boolean>;
    };
  },
) => CustomerAuth;
