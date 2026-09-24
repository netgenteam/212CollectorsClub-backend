import { createHash } from 'node:crypto';
import {
  hashOrderAccessToken,
  timingSafeEqualHex,
} from './order-access-token.js';

describe('order-access-token', () => {
  describe('hashOrderAccessToken', () => {
    it('returns the SHA-256 hex digest of the raw token (same algorithm CheckoutService persists on accessTokenHash)', () => {
      const rawToken = 'a-raw-token-value';
      const expected = createHash('sha256').update(rawToken).digest('hex');
      expect(hashOrderAccessToken(rawToken)).toBe(expected);
    });

    it('is deterministic and case/format-sensitive (different input -> different hash)', () => {
      expect(hashOrderAccessToken('token-a')).not.toBe(
        hashOrderAccessToken('token-b'),
      );
      expect(hashOrderAccessToken('token-a')).toBe(
        hashOrderAccessToken('token-a'),
      );
    });
  });

  describe('timingSafeEqualHex', () => {
    it('returns true for two equal hex hashes', () => {
      const hash = hashOrderAccessToken('same-token');
      expect(timingSafeEqualHex(hash, hash)).toBe(true);
    });

    it('returns false for two different (but same-length) hex hashes', () => {
      const hashA = hashOrderAccessToken('token-a');
      const hashB = hashOrderAccessToken('token-b');
      expect(timingSafeEqualHex(hashA, hashB)).toBe(false);
    });

    it('returns false (never throws) when lengths differ, instead of letting crypto.timingSafeEqual raise', () => {
      const hash = hashOrderAccessToken('some-token');
      expect(() => timingSafeEqualHex(hash, hash.slice(0, 10))).not.toThrow();
      expect(timingSafeEqualHex(hash, hash.slice(0, 10))).toBe(false);
    });
  });
});
