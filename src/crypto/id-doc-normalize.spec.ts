import { describe, expect, it } from 'vitest';
import { normalizeIdDoc } from './id-doc-normalize.js';

describe('normalizeIdDoc (AC3)', () => {
  it.each([
    ['V12345678', 'V', '12345678'],
    ['v-12.345.678', 'V', '12345678'],
    ['  V 12 345 678  ', 'V', '12345678'],
    ['V-12345678', 'V', '12345678'],
    ['e-1234567', 'E', '1234567'],
    ['E 1.234.567', 'E', '1234567'],
    ['J-12345678-9', 'J', '123456789'],
    ['J123456789', 'J', '123456789'],
    ['g-20000003-1', 'G', '200000031'],
    ['P-123456', 'P', '123456'],
    ['p a1234567', 'P', 'A1234567'],
    ['V\u200B-1234\u00A05678', 'V', '12345678'], // invisible / non breaking space
    ['\uFF36\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17\uFF18', 'V', '12345678'], // full width
    ['V-00012345', 'V', '00012345'],
  ])('%j -> %s-%s', (raw, type, digits) => {
    const n = normalizeIdDoc(raw)!;
    expect(n.unparsed).toBe(false);
    expect(n.type).toBe(type);
    expect(n.digits).toBe(digits);
    expect(n.canonical).toBe(`${type}-${digits}`);
  });

  it('gives one canonical form for every spelling of the same ID', () => {
    const forms = [
      'V12345678',
      'v-12.345.678',
      'V 12345678',
      ' v-12345678 ',
      'V.12.345.678',
      'V-12345678',
    ];
    expect(new Set(forms.map((f) => normalizeIdDoc(f)!.canonical)).size).toBe(
      1,
    );
  });

  it('never merges different IDs (type, digits and leading zeros all count)', () => {
    const vals = [
      'V12345678',
      'E12345678',
      'J12345678',
      'V12345679',
      'V012345678',
      'V1234567',
      'P12345678',
      'G12345678',
    ];
    expect(new Set(vals.map((f) => normalizeIdDoc(f)!.canonical)).size).toBe(
      vals.length,
    );
  });

  it.each([
    ['12345678', '12345678'], // no type: not guessed
    ['V-123', 'V-123'], // too short
    ['sin  cedula', 'SIN CEDULA'],
    ['V-12345678X', 'V-12345678X'],
    ['X-12345678', 'X-12345678'], // unknown type
    ['V_12345678', 'V_12345678'],
    ['V-1234567890123', 'V-1234567890123'], // too long
    ['PENDING', 'PENDING'],
    ['PABCDEFG', 'PABCDEFG'], // passport without a digit
  ])(
    'keeps legacy %j as unparsed %j without guessing a type',
    (raw, canonical) => {
      const n = normalizeIdDoc(raw)!;
      expect(n).toEqual({
        type: null,
        digits: null,
        canonical,
        unparsed: true,
      });
    },
  );

  it('returns null for null, undefined, blank and non-strings and never throws', () => {
    for (const v of [
      null,
      undefined,
      '',
      '   ',
      '​',
      5,
      {},
      [],
      true,
      Symbol('x'),
    ]) {
      expect(normalizeIdDoc(v)).toBeNull();
    }
    expect(normalizeIdDoc('V'.repeat(100_000))!.unparsed).toBe(true);
    expect(
      normalizeIdDoc('V'.repeat(100_000))!.canonical.length,
    ).toBeLessThanOrEqual(256);
    expect(() => normalizeIdDoc('𐀀\uD800 V1')).not.toThrow();
  });
});
