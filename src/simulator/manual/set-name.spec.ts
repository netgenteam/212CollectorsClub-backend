import { describe, expect, it } from 'vitest';
import { assertAuditSafeText, normalizeSetName } from './set-name.js';

describe('normalizeSetName (Story 22.4, AC3)', () => {
  it('trims, collapses whitespace and lower-cases the key', () => {
    expect(normalizeSetName('  Mi \t  Set ')).toEqual({
      name: 'Mi Set',
      nameKey: 'mi set',
    });
    expect(normalizeSetName('mi set').nameKey).toBe(
      normalizeSetName('  Mi  Set ').nameKey,
    );
  });
  it.each([
    '',
    '   ',
    '\n\t',
    'a\u0000b',
    'x'.repeat(121),
    42,
    null,
    undefined,
  ])('rejects %j with a 400', (v) =>
    expect(() => normalizeSetName(v)).toThrow(/name/),
  );
  it('accepts exactly 120 characters (code points)', () => {
    expect(normalizeSetName('x'.repeat(120)).name).toHaveLength(120);
    expect(() => normalizeSetName('😀'.repeat(120))).not.toThrow();
    expect(() => normalizeSetName('😀'.repeat(121))).toThrow();
  });
  it('rejects a name whose lower-cased key would overflow the column', () => {
    expect(() => normalizeSetName('İ'.repeat(120))).toThrow(/120/);
  });

  it.each([
    'juan.perez@gmail.com',
    'V-12345678 cedula',
    '+58 414 1234567',
    'password=hunter22',
    '4111111111111111',
  ])('rejects PII-looking name %j with a 400', (v) =>
    expect(() => normalizeSetName(v)).toThrow(/must not contain/),
  );
  it('assertAuditSafeText flags a URL with an email, accepts plain text', () => {
    expect(() =>
      assertAuditSafeText('imageUrl', 'https://x.com/juan@gmail.com.png'),
    ).toThrow(/imageUrl/);
    expect(() => assertAuditSafeText('name', 'Base Set 151')).not.toThrow();
  });
});
