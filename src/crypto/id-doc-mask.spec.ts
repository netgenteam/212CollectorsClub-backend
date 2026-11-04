import { describe, expect, it } from 'vitest';
import { maskIdDoc } from './id-doc-mask.js';
import { serializeIdDoc } from './id-doc-serialize.js';

describe('maskIdDoc (AC5)', () => {
  it.each([
    ['V-12345678', 'V-****5678'],
    ['v12345678', 'V-****5678'],
    ['J-123456789', 'J-****6789'],
    ['E-1234567', 'E-****4567'],
    ['V-12345', 'V-****2345'],
    ['V-1234', 'V-****'],
    ['v 12', 'V-****'],
    ['P-A1234567', 'P-****4567'],
    ['12345678', '****5678'], // legacy, no type
    ['1234', '****'],
    ['SIN CEDULA', '****'],
    ['ABC', '****'],
  ])('%j -> %j', (input, out) => {
    expect(maskIdDoc(input)).toBe(out);
  });

  it('never exposes more than the type and the last 4 digits', () => {
    for (const raw of [
      'V-12345678',
      'J-123456789',
      'E-1234567',
      'V-12345',
      'P-A1234567',
    ]) {
      const m = maskIdDoc(raw)!;
      const shown = m.replace(/[^0-9]/g, '');
      expect(shown.length).toBeLessThanOrEqual(4);
      expect(m).toMatch(/^[VEJGP]-\*{4}\w{0,4}$/);
    }
  });

  it('never throws and returns null for null/blank/non-string', () => {
    for (const v of [null, undefined, '', '  ', 0, {}, [], NaN])
      expect(maskIdDoc(v)).toBeNull();
    expect(() => maskIdDoc('\uD800')).not.toThrow();
  });
});

describe('serializeIdDoc (AC5)', () => {
  const crypto = {
    isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('ENC:'),
    decrypt: (v: string) => {
      if (v === 'ENC:bad') throw new Error('boom');
      return v.slice(4);
    },
  };
  it('prefers enc, falls back to plain, masks always, null when empty', () => {
    expect(serializeIdDoc(crypto, 'ENC:V-12345678', 'E-1')).toBe('V-****5678');
    expect(serializeIdDoc(crypto, null, 'v12345678')).toBe('V-****5678');
    expect(serializeIdDoc(crypto, undefined, undefined)).toBeNull();
    expect(serializeIdDoc(crypto, '', '')).toBeNull();
  });
  it('returns null (no throw, no value) when decryption fails', () => {
    expect(serializeIdDoc(crypto, 'ENC:bad')).toBeNull();
  });
});
