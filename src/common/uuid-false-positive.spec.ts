import { describe, expect, it } from 'vitest';
import { redactText } from '../audit/audit-payload.js';
import { looksLikeIdDocInText } from './id-doc-not-in-url.js';
import { redactString } from './redact.js';

/**
 * Story 20.6a: a random UUID must never be taken for personal data by any of the three detectors
 * (the audit guard, the log redactor, the URL/reason check). 1e31b41 closed the guard's phone pattern
 * (`58 2xx xxx-xxxx` at the start of a UUID); the log redactor still masked `...-ced6-4771-...`
 * (a `ced` label followed by 5 digits across the hyphen). Both are pinned here with the exact
 * UUIDs, and a seeded sweep (deterministic, so a failure replays) covers the digit-heavy ones.
 */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const hex = (rnd: () => number, n: number, digitsOnly: boolean) =>
  Array.from({ length: n }, () =>
    digitsOnly
      ? String(Math.floor(rnd() * 10))
      : '0123456789abcdef'[Math.floor(rnd() * 16)],
  ).join('');

const uuid = (rnd: () => number, digitsOnly: boolean) =>
  `${hex(rnd, 8, digitsOnly)}-${hex(rnd, 4, digitsOnly)}-4${hex(rnd, 3, digitsOnly)}-8${hex(rnd, 3, digitsOnly)}-${hex(rnd, 12, digitsOnly)}`;

const CONTEXTS: ((u: string) => string)[] = [
  (u) => u,
  (u) => `ref ${u}`,
  (u) => `${u} ok`,
  (u) => `"${u}"`,
  (u) => `ORD-${u}`,
  (u) => `/api/v1/orders/${u}/x`,
  (u) => `id=${u}&a=1`,
];

function offenders(s: string): string[] {
  const out: string[] = [];
  const g = redactText(s).hits;
  if (g.length > 0) out.push(`guard:${g.join()}`);
  if (redactString(s) !== s) out.push('redactor');
  if (looksLikeIdDocInText(s)) out.push('url-check');
  return out;
}

describe('a UUID is never personal data (Story 20.6a)', () => {
  it.each([
    '582d20f6-ced6-4771-aa03-294ee7e80971', // `ced6-4771`: a label and 5 digits
    '58200123-4567-4abc-8def-0123456789ab', // `58 2xx xxx-xxxx`
    '58212345-6789-4abc-8def-0123456789ab',
    '04121234-5678-4abc-8def-0123456789ab', // `0412 xxx-xxxx`
    '12345678-1234-4234-8234-123456789012', // digits only
    '7c1d2e3f-4a5b-4c6d-8e9f-123456789012', // long run of digits at the end
    'e1234567-89ab-4cde-8f01-234567890123',
    'ab12cd34-ced1-2345-a678-9abcdef01234',
  ])('%s', (u) => {
    for (const c of CONTEXTS) expect(offenders(c(u)), c(u)).toEqual([]);
  });

  it('sweep: 40 000 seeded UUIDs (half of them digits only, a quarter shaped like a phone) in 7 contexts', () => {
    const rnd = mulberry32(2064);
    const bad: string[] = [];
    for (let i = 0; i < 40_000; i++) {
      let u = uuid(rnd, i % 2 === 0);
      if (i % 4 === 1)
        u = `${['58200', '58412', '04121', '58212'][i % 4 === 1 ? i % 3 : 0]}${u.slice(5)}`;
      const c = CONTEXTS[i % CONTEXTS.length];
      const o = offenders(c(u));
      if (o.length > 0) bad.push(`${c(u)} -> ${o.join()}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('a real label followed by a number is still masked (the fix did not open a hole)', () => {
    expect(redactString('cedula 12345678')).not.toContain('12345678');
    expect(redactString('ci: 12345678')).not.toContain('12345678');
    expect(redactString('pedido ced 12345')).not.toContain('12345');
  });
});
