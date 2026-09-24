import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Story 4.1 (AD-17) introduced the `orderAccessToken` mechanism: a raw,
 * one-time opaque token (`crypto.randomBytes(32).toString('hex')`) handed to
 * the buyer exactly once in the checkout response, whose SHA-256 hex digest
 * — never the raw value — is persisted on `Order.accessTokenHash`.
 *
 * This module is the single shared place that hashes/compares that token,
 * extracted out of `CheckoutService` (which still generates it) so that
 * Story 4.2 (and any later buyer-facing Order route gated the same way,
 * e.g. Story 5.1's order lookup) verifies it with the *exact* same
 * algorithm instead of a second, possibly-diverging implementation. See
 * `CheckoutService`'s own doc comment (`generateOrderAccessToken`) for why
 * a fast hash (not bcrypt/argon2) is the correct primitive here.
 */
export function hashOrderAccessToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Constant-time comparison between a freshly-hashed candidate token and the
 * hash persisted on an Order — used instead of plain `===` string
 * comparison to avoid a timing side-channel that could let an attacker
 * incrementally recover a valid `accessTokenHash` byte-by-byte.
 *
 * `crypto.timingSafeEqual` throws if the two buffers differ in length
 * (rather than just returning `false`), which a malformed/wrong-length
 * `accessTokenHash` — impossible in practice since this codebase never
 * persists anything other than a SHA-256 hex digest here, but never trust
 * that from a security-sensitive comparison — would otherwise turn into an
 * uncaught 500. Lengths are compared first so a mismatch is just "not
 * equal", never an exception.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
