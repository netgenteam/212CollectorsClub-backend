import { describe, expect, it } from 'vitest';
import {
  cleanIp,
  codePointLength,
  pgText,
  truncateCodePoints,
} from './audit-normalize.js';
import { canonicalJSON } from './canonical-json.js';

describe('pgText: the string as Postgres will store it (Story 20.1, round trip)', () => {
  it('lone surrogates and NUL become U+FFFD; everything else is untouched; idempotent', () => {
    expect(pgText('emoji cut \ud83d')).toBe('emoji cut \ufffd');
    expect(pgText('x\ud800y')).toBe('x\ufffdy');
    expect(pgText('\udc00')).toBe('\ufffd');
    expect(pgText('\ude00\ud83d')).toBe('\ufffd\ufffd'); // reversed pair: both lone
    expect(pgText('a\u0000b')).toBe('a\ufffdb');
    expect(pgText('😀 ok é 日本 ‮ ￿  ')).toBe('😀 ok é 日本 ‮ ￿  ');
    expect(pgText(pgText('\ud800\u0000'))).toBe('\ufffd\ufffd');
    expect(pgText('')).toBe('');
  });

  it('agrees with the platform toWellFormed() (+ NUL)', () => {
    const samples = ['a', '\ud800', '😀\ud800😀', '\udfff\ud800', 'x😀y\ud83d'];
    for (const s of samples)
      expect(pgText(s)).toBe(
        (s as unknown as { toWellFormed(): string }).toWellFormed(),
      );
  });

  it('canonicalJSON hashes the stored form: a lone surrogate and U+FFFD give the same text', () => {
    expect(canonicalJSON({ a: 'x\ud800' })).toBe(
      canonicalJSON({ a: 'x\ufffd' }),
    );
    expect(canonicalJSON({ 'k\ud800': 1 })).toBe(
      canonicalJSON({ 'k\ufffd': 1 }),
    );
    expect(canonicalJSON('x\u0000')).toBe(canonicalJSON('x\ufffd'));
  });
});

describe('code point helpers (varchar(n) counts characters, not UTF-16 units)', () => {
  it('counts and truncates by code point, never splitting a pair', () => {
    expect(codePointLength('a😀b')).toBe(3);
    expect(truncateCodePoints('😀'.repeat(10), 3)).toBe('😀😀😀');
    expect(truncateCodePoints('abc', 5)).toBe('abc');
    expect(truncateCodePoints('a😀b', 2)).toBe('a😀');
    expect(truncateCodePoints('😀'.repeat(600), 500)).toBe('😀'.repeat(500));
    expect(truncateCodePoints('abc', 0)).toBe('');
  });
});

describe('cleanIp: only text Postgres can cast to inet, or null (never a throw)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:DB8::1', '2001:DB8::1'],
    ['::1', '::1'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['  10.0.0.1  ', '10.0.0.1'],
    ['1.2.3.4\n', '1.2.3.4'],
    ['fe80::1%eth0', 'fe80::1'],
    ['fe80::1%1', 'fe80::1'],
    ['[::1]', '::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['1.2.3.4:8080', '1.2.3.4'],
    ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:1'],
  ])('%s -> %s', (raw, want) => {
    expect(cleanIp(raw)).toBe(want);
  });

  it.each([
    '',
    ' ',
    'unknown',
    'localhost',
    '1.2.3',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.4/24',
    '1.2.3.4, 5.6.7.8',
    'fe80::1%',
    'fe80::1%eth 0',
    'fe80::1%ñ',
    'fe80::1%' + 'a'.repeat(40),
    '::1%eth0%eth1',
    ':::1',
    '1:2:3:4:5:6:7:8:9',
    'g::1',
    '1.2.3.4\u0000',
    '1.2.3.4:99999x',
    '[::1',
    'x'.repeat(100),
    '😀',
    '\ud800',
  ])('%j -> null', (raw) => {
    expect(cleanIp(raw)).toBeNull();
  });

  it('non-strings are null', () => {
    expect(cleanIp(undefined)).toBeNull();
    expect(cleanIp(null)).toBeNull();
    expect(cleanIp(5 as never)).toBeNull();
  });
});
