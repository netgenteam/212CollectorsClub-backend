import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestCrypto } from '../../test/helpers/iddoc-test-crypto.js';

/** Story 20.3 (QA of 20.2): a malformed `Enc` is never read as a legacy value, and it is logged without the value. */
describe('serializeIdDoc: malformed Enc', () => {
  const svc = makeTestCrypto();
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['plain text in Enc', 'V-12345678'],
    ['a truncated ciphertext', 'v1:abc:def'],
    [
      'a ciphertext with a bad tag part',
      'v1:' + 'A'.repeat(16) + ':' + '!'.repeat(22) + ':QQ',
    ],
    ['garbage', '????'],
  ])(
    '%s + a plain value present -> null, logged once, no fallback, no value in the log',
    (_n, enc) => {
      expect(svc.serialize(enc, 'V-87654321')).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('IDDOC_ENC_MALFORMED');
      const all = errors.join('|');
      expect(all).not.toContain('87654321');
      expect(all).not.toContain('12345678');
    },
  );

  it('a valid ciphertext that cannot be authenticated is logged as IDDOC_DECRYPT_FAILED', () => {
    const good = svc.encrypt('V-12345678');
    const bad = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
    expect(svc.serialize(bad, 'V-87654321')).toBeNull();
    expect(errors.join('|')).toContain('IDDOC_DECRYPT_FAILED');
  });

  it('absent Enc (null or empty) still falls back to the legacy plain value; nothing is logged', () => {
    expect(svc.serialize(null, 'V-12345678')).toBe('V-****5678');
    expect(svc.serialize('', 'V-12345678')).toBe('V-****5678');
    expect(errors).toHaveLength(0);
  });
});
