import { describe, expect, it } from 'vitest';
import {
  isRifCheckDigitStrict,
  isValidRif,
  rifCheckDigit,
} from './rif-check-digit.js';

describe('rifCheckDigit (AC6, A98)', () => {
  // Hand-computed with weights 4 3 2 7 6 5 4 3 2 over [letter, d1..d8].
  // J-07013380-5 is the published RIF of Banesco (sum 83, 83 mod 11 = 6, 11-6 = 5).
  it.each([
    ['J', '07013380', 5],
    ['V', '12345678', 1], // sum 142 -> 142 mod 11 = 10 -> 1
    ['G', '20000003', 1], // sum 32 -> mod 10 -> 1
    ['E', '81000000', 9],
    ['J', '00000000', 9],
    ['V', '00000001', 5],
    ['V', '00000009', 0], // sum mod 11 = 0 -> 11 -> 0
    ['V', '00000004', 9], // sum mod 11 = 1 -> 10 -> 9
  ])('%s-%s -> %i', (t, d, dv) => {
    expect(rifCheckDigit(t as 'V', d)).toBe(dv);
  });

  it('rejects a malformed first8', () => {
    expect(() => rifCheckDigit('V', '1234567')).toThrow(TypeError);
    expect(() => rifCheckDigit('V', 'abcdefgh')).toThrow(TypeError);
  });
});

describe('isValidRif', () => {
  it('accepts valid RIFs and rejects a wrong check digit or letter (strict)', () => {
    expect(isValidRif('J', '070133805', { strict: true })).toBe(true);
    expect(isValidRif('J', '070133806', { strict: true })).toBe(false);
    expect(isValidRif('V', '123456781', { strict: true })).toBe(true);
    expect(isValidRif('V', '123456780', { strict: true })).toBe(false);
    expect(isValidRif('E', '810000009', { strict: true })).toBe(true);
    expect(isValidRif('G', '200000031', { strict: true })).toBe(true);
    expect(isValidRif('G', '200000032', { strict: true })).toBe(false);
    expect(isValidRif('V', '000000090', { strict: true })).toBe(true);
    expect(isValidRif('V', '000000049', { strict: true })).toBe(true);
  });

  it('a letter changes the result (V vs E over the same digits)', () => {
    expect(isValidRif('E', '123456781', { strict: true })).toBe(false);
  });

  it('format is always required, with or without strict mode', () => {
    for (const strict of [true, false]) {
      expect(isValidRif('X', '070133805', { strict })).toBe(false);
      expect(isValidRif('J', '07013380', { strict })).toBe(false);
      expect(isValidRif('J', '0701338055', { strict })).toBe(false);
      expect(isValidRif('J', '07013380A', { strict })).toBe(false);
      expect(isValidRif('toString', '070133805', { strict })).toBe(false);
    }
  });

  it('RIF_CHECKDIGIT_STRICT=false degrades to format only', () => {
    expect(isRifCheckDigitStrict({})).toBe(true);
    expect(isRifCheckDigitStrict({ RIF_CHECKDIGIT_STRICT: 'true' })).toBe(true);
    expect(isRifCheckDigitStrict({ RIF_CHECKDIGIT_STRICT: 'false' })).toBe(
      false,
    );
    expect(isRifCheckDigitStrict({ RIF_CHECKDIGIT_STRICT: ' FALSE ' })).toBe(
      false,
    );
    expect(isValidRif('J', '070133806', { strict: false })).toBe(true);
    const prev = process.env.RIF_CHECKDIGIT_STRICT;
    process.env.RIF_CHECKDIGIT_STRICT = 'false';
    try {
      expect(isValidRif('J', '070133806')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RIF_CHECKDIGIT_STRICT;
      else process.env.RIF_CHECKDIGIT_STRICT = prev;
    }
  });
});
