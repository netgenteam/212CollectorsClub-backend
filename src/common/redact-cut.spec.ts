import { describe, expect, it } from 'vitest';
import { CUT_MARGIN, commonPrefix, redactedPrefix } from './redact-cut.js';
import {
  MAX_KEY_CHARS,
  MAX_STRING_CHARS,
  redactDeep,
  redactString,
} from './redact.js';

/**
 * QA round 3 of Story 20.5: REDACT BEFORE CUTTING. A token that straddles the cut must leave no
 * prefix in the (immutable) output. The sweep puts the token at every position around the cut.
 */
const RISKY = '1'.repeat(70); // a 64+ digit run: the shape that makes `redactString` cut (see redact.ts)

/** Does `out` still hold a prefix of `token` at least `min` characters long? */
function leaks(out: string, token: string, min: number): string | null {
  for (let k = min; k < token.length; k += 1) {
    if (out.includes(token.slice(0, k))) return token.slice(0, k);
  }
  return null;
}

describe('commonPrefix / redactedPrefix', () => {
  it('commonPrefix', () => {
    expect(commonPrefix('abcdef', 'abcxyz')).toBe('abc');
    expect(commonPrefix('abc', 'abc')).toBe('abc');
    expect(commonPrefix('', 'abc')).toBe('');
  });
  it('never ends in the middle of a surrogate pair', () => {
    // '😀' = D83D DE00; the two texts differ in the low surrogate
    expect(commonPrefix('a\u{1F600}', 'a\u{1F601}')).toBe('a');
  });
  it('a text that fits is redacted whole', () => {
    expect(redactedPrefix('abc', 10, (s) => s.toUpperCase())).toBe('ABC');
  });
  it('a token that straddles the cut is replaced (or left out), never half shown', () => {
    const redact = (s: string): string => s.replace(/SECRET\d{4}/g, '[X]');
    for (let at = 0; at <= 20; at += 1) {
      const input = `${'.'.repeat(at)}SECRET1234${'.'.repeat(50)}`;
      const out = redactedPrefix(input, 20, redact, 64);
      expect(out, `at=${at}`).not.toMatch(/SECR|SECRET1/);
    }
  });
  it('margin is 512 or more: longer than an email (254) and a stored ciphertext (~450)', () => {
    expect(CUT_MARGIN).toBeGreaterThanOrEqual(512);
  });
});

describe('redactString: a cedula or a field value straddling the 8 192 cut leaves no prefix', () => {
  const tokens = [
    'V-76543210',
    'V76543210',
    'V-76.543.210',
    'J-76543210-9',
    'ci: 76543210',
    'cedula 76543210',
    'recipientIdDoc: 76543210',
    'idDoc=7654321',
    '"idDoc":"7654321"',
    'v1:abcdefghijklmnop:abcdefghijklmnopqrstuv:abcdefghijklmnopqrstuvwxyz0123',
  ];
  for (const token of tokens) {
    it(`token ${JSON.stringify(token.slice(0, 18))} at every position around the cut`, () => {
      const from = MAX_STRING_CHARS - token.length - 4;
      for (let p = from; p <= MAX_STRING_CHARS + 4; p += 1) {
        // filler that ends in a space (the token must start a word) and holds the risky run
        const body = `${RISKY} ${'x '.repeat(Math.ceil(p / 2))}`
          .slice(0, p - 1)
          .concat(' ');
        const input = `${body}${token} tail ${'y '.repeat(300)}`;
        const out = redactString(input);
        expect(out, `p=${p}`).toMatch(/\[TRUNCATED:\d+ chars\]$/);
        // the field name may stay (a label), the value must not
        const value = token.replace(/^[^0-9]*?(?=\d)/, '');
        expect(leaks(out, value, 3), `p=${p} value`).toBeNull();
        // a bare token (no label) must not show even its first characters
        if (/^[VJvj]/.test(token) && !token.includes(':')) {
          expect(leaks(out, token, 2), `p=${p} token`).toBeNull();
        }
      }
    });
  }
});

describe('redactDeep: an object key cut at 256 characters leaves no prefix of a cedula', () => {
  for (const token of ['V-76543210', 'ci: 76543210', 'v76.543.210']) {
    it(`token ${token} at every position around the cut`, () => {
      for (
        let p = MAX_KEY_CHARS - token.length - 4;
        p <= MAX_KEY_CHARS + 4;
        p += 1
      ) {
        const key = `${'k'.repeat(p)}-${token} ${'z'.repeat(40)}`;
        const out = redactDeep({ [key]: 1 });
        const shown = Object.keys(out)[0];
        // the label (`ci:`) may stay, the number may not
        expect(leaks(shown, token.replace(/^\D*/, ''), 3), `p=${p}`).toBeNull();
        // a marker is longer than the token it replaces: a little over the cut, never the whole key
        expect(shown.length).toBeLessThanOrEqual(MAX_KEY_CHARS + 32);
      }
    });
  }
  it('a cedula used as a KEY is redacted even when the key is short', () => {
    const out = redactDeep({ 'V-76543210': 'x' });
    expect(Object.keys(out)[0]).not.toMatch(/76543210/);
  });
});
