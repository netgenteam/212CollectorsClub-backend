import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declaration file
import { assertSaslprepStable, scramVerifier } from './scram-verifier.mjs';

const build = scramVerifier as (
  pw: string,
  o?: { salt?: Buffer; iterations?: number },
) => string;
const stable = assertSaslprepStable as (pw: string) => string;

/**
 * Golden values written by a real PostgreSQL 17 (`SET password_encryption =
 * 'scram-sha-256'; ALTER ROLE ... PASSWORD 'aAb'`, read back from pg_authid).
 */
const PG: [string, string][] = [
  [
    'aAb',
    'SCRAM-SHA-256$4096:X504R/v3DATjxBqzqbo1KA==$fJaO3gTSgvO3XwEZAvS39nomWELEHklHxgSzDm5898E=:6EhgNe3gy1ZH22kM6n/uGqf9qEeJX0RPrOZv4FJL5BU=',
  ],
  [
    'aéb', // precomposed e-acute: already NFKC, SASLprep leaves it alone
    'SCRAM-SHA-256$4096:dCGbsg2zn7U5wZnmINy2tg==$G3WG84ocwGc2q+jsfHdTiSXbH44BW/RIl75fYtfWBMA=:io0ehJYeuYrgDNYMEdX2oj1kvVOEoP1VEn22Bmx9eQc=',
  ],
];

describe('scramVerifier equals the verifier PostgreSQL computes (Story 20.1, QA round 3)', () => {
  it.each(PG)('golden value for %j', (pw, pg) => {
    const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$(.+)$/.exec(pg)!;
    expect(
      build(pw, { salt: Buffer.from(m[2], 'base64'), iterations: +m[1] }),
    ).toBe(pg);
  });

  it('ASCII passwords (any printable or control character) pass through untouched', () => {
    expect(stable('Correct Horse Battery Staple 9!')).toBe(
      'Correct Horse Battery Staple 9!',
    );
    expect(() => build('with\ttab\x01')).not.toThrow();
  });

  // Built from code points: invisible characters must stay visible in the source.
  const cp = (...c: number[]) => String.fromCodePoint(...c);

  it('text that SASLprep leaves unchanged is accepted (accents already composed, emoji, CJK)', () => {
    for (const pw of [
      `cafe${cp(0xe9)}`,
      `${cp(0x1f600)}zq9x`,
      `${cp(0x65e5, 0x672c, 0x8a9e)}-zq9x`,
    ]) {
      expect(() => build(pw)).not.toThrow();
    }
  });

  it.each([
    ['soft hyphen U+00AD', cp(0x7a, 0xad, 0x71)],
    ['zero width space U+200B', cp(0x7a, 0x200b, 0x71)],
    ['byte order mark U+FEFF', cp(0xfeff, 0x7a, 0x71)],
    ['mongolian free variation selector U+1806', cp(0x7a, 0x1806, 0x71)],
    ['variation selector U+FE0F', cp(0x7a, 0xfe0f, 0x71)],
    ['combining grave tone mark U+0340', cp(0x7a, 0x340, 0x71)],
    ['no-break space U+00A0', cp(0x7a, 0xa0, 0x71)],
    ['ideographic space U+3000', cp(0x7a, 0x3000, 0x71)],
    ['compatibility letter (fullwidth A)', cp(0x7a, 0xff21, 0x71)],
    ['a combining sequence NFKC composes', cp(0x65, 0x301)],
    ['replacement character (invalid UTF-8 upstream)', cp(0x7a, 0xfffd, 0x71)],
  ])('refuses %s with a clear message', (_n, pw) => {
    let msg = '';
    try {
      build(pw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SASLprep/);
    expect(msg).toMatch(/ASCII/);
  });
});
