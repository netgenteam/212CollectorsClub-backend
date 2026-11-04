import { describe, expect, it } from 'vitest';
import {
  emailSpans,
  redactReasonCut,
  redactText,
  sanitizeAuditPayload,
} from './audit-payload.js';

/**
 * QA round 3 of Story 20.5. In lenient mode (production) a string over 8 000 characters, a key
 * over 256 and a `reason` over 2 000 code points are cut. Cutting first and redacting after left a
 * prefix of the token that straddled the cut (`V-123456`, `maria@gmail`) in an IMMUTABLE row. Every
 * token is swept across the positions around each cut.
 */
const MAX_STRING = 8_000;
const MAX_KEY = 256;
const MAX_REASON = 2_000;

const TOKENS: Array<{ name: string; token: string; min: number }> = [
  { name: 'cedula', token: 'V-12345678', min: 3 },
  { name: 'cedula dotted', token: 'V-12.345.678', min: 3 },
  { name: 'RIF', token: 'J-123456789', min: 3 },
  { name: 'phone +58', token: '+58 412 123 4567', min: 4 },
  { name: 'phone 04xx', token: '04121234567', min: 4 },
  { name: 'email', token: 'maria.perez@example.com', min: 4 },
  { name: 'token', token: 'sk_live_abc123def456ghi789', min: 4 },
  { name: 'bearer', token: 'Bearer abcdef123456uvwxyz', min: 8 },
  { name: 'labelled cedula', token: 'cedula 12345678', min: 12 },
];

function leaks(out: string, token: string, min: number): string | null {
  for (let k = min; k <= token.length; k += 1) {
    if (out.includes(token.slice(0, k))) return token.slice(0, k);
  }
  return null;
}

const lenient = (v: unknown) => sanitizeAuditPayload(v, 'lenient');

describe('lenient cut of a value: redact first, cut after', () => {
  for (const { name, token, min } of TOKENS) {
    it(`${name} at every position around the ${MAX_STRING} cut`, () => {
      for (let p = MAX_STRING - token.length - 3; p <= MAX_STRING + 3; p += 1) {
        const value = `${'x '.repeat(p / 2)}`.slice(0, p) + `${token} tail`;
        const out = lenient({ note: value + ' z'.repeat(400) }).value as {
          note: string;
        };
        expect(leaks(out.note, token, min), `p=${p}`).toBeNull();
      }
    });
  }
  it('the cut value is flagged (issue) and still masked in strict mode (throws)', () => {
    const big = `${'x '.repeat(4000)}V-12345678 ${'y '.repeat(400)}`;
    const r = lenient({ note: big });
    expect(r.issues.some((i) => /longer than 8000/.test(i.why))).toBe(true);
    expect(() => sanitizeAuditPayload({ note: big }, 'strict')).toThrow();
  });
});

describe('lenient cut of a KEY: redact first, cut after', () => {
  for (const { name, token, min } of TOKENS) {
    it(`${name} at every position around the ${MAX_KEY} cut`, () => {
      for (let p = MAX_KEY - token.length - 3; p <= MAX_KEY + 3; p += 1) {
        const key =
          `${'k '.repeat(p / 2)}`.slice(0, p) + token + ' tail zzzzzz';
        const out = lenient({ [key]: 'v' }).value as Record<string, string>;
        const shown = Object.keys(out).join('|');
        expect(leaks(shown, token, min), `p=${p}`).toBeNull();
      }
    });
  }
});

describe('the reason: redact first, cut after (2 000 code points)', () => {
  for (const { name, token, min } of TOKENS) {
    it(`${name} at every position around the ${MAX_REASON} cut`, () => {
      for (let p = MAX_REASON - token.length - 3; p <= MAX_REASON + 3; p += 1) {
        const reason = `${'x '.repeat(p / 2)}`.slice(0, p) + token + ' tail zz';
        const r = redactReasonCut(reason + ' z'.repeat(100), MAX_REASON);
        expect(leaks(r.text, token, min), `p=${p}`).toBeNull();
      }
    });
  }
  it('a short reason is redacted as before', () => {
    const r = redactReasonCut(
      'write to maria@example.com about V-12345678',
      2000,
    );
    expect(r.text).toBe('write to [REDACTED:EMAIL] about [REDACTED:CEDULA]');
    expect(r.hits.sort()).toEqual(['CEDULA', 'EMAIL']);
  });
});

describe('emailSpans is the linear twin of /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/g', () => {
  const vocabulary = [
    'a',
    '@',
    '.',
    ' ',
    'b@c.d',
    'x',
    '@@',
    '\n',
    ' ',
    '..',
    '-',
    '1',
    'a.b',
    '@.',
    '.@',
  ];
  it('gives the same spans on 100 000 generated strings', () => {
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 100_000; i += 1) {
      const n = 1 + Math.floor(rnd() * 12);
      let s = '';
      for (let j = 0; j < n; j += 1) {
        s += vocabulary[Math.floor(rnd() * vocabulary.length)];
      }
      const expected = [...s.matchAll(/[^\s@]+@[^\s@]+\.[^\s@]+/g)].map((m) => [
        m.index,
        m.index + m[0].length,
      ]);
      expect(emailSpans(s), JSON.stringify(s)).toEqual(expected);
    }
  });
  it('masks emails exactly as before', () => {
    expect(redactText('mail a@b.co and x@y.zz!').text).toBe(
      'mail [REDACTED:EMAIL] and [REDACTED:EMAIL]',
    );
    expect(redactText('a@b').hits).toEqual([]);
  });
});

describe('a UUID whose first segment looks like a Venezuelan phone is not a phone (QA round 3, flaky fuzz)', () => {
  it('58228257-2520-466c-8d73-a8a8bfdc080c (1 UUID in ~300 000 matched)', () => {
    expect(redactText('58228257-2520-466c-8d73-a8a8bfdc080c').hits).toEqual([]);
    expect(redactText('02121234567-8d73').hits).toEqual([]);
  });
  it('real phones are still masked', () => {
    for (const p of [
      '04141234567',
      '0414-123-4567',
      '+58 414 123 4567',
      '58 212 123 4567',
      'call 0212 123 4567.',
    ]) {
      expect(redactText(p).hits, p).toContain('PHONE');
    }
  });
});
