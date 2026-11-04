import { describe, expect, it } from 'vitest';
import { redactDeep, redactString } from './../src/common/redact.js';
import { sanitizeAuditPayload } from './../src/audit/audit-payload.js';

/**
 * Story 20.5 follow-up, perf (pnpm test:perf): the audit payload guard and the log redactor run
 * quadratic regexes on one unbroken run of digits. Before the caps: a 150 000-digit KEY took
 * 11.3 s, 500 strings of 8 000 digits 16.5 s, `redactDeep` of a 100 000-digit string 3.9-5.3 s,
 * all on the main thread. Figures are printed for the report.
 */
const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
const timed = (label: string, fn: () => unknown): number => {
  const t0 = nowMs();
  fn();
  const ms = nowMs() - t0;
  console.info(`${label}: ${ms.toFixed(1)} ms`);
  return ms;
};

describe('bounded work on hostile input', () => {
  it('guard: a 150 000-digit key (lenient and strict)', () => {
    const v = { ['1'.repeat(150_000)]: 'x' };
    expect(
      timed('guard key 150000 digits, lenient', () =>
        sanitizeAuditPayload(v, 'lenient'),
      ),
    ).toBeLessThan(250);
    expect(
      timed('guard key 150000 digits, strict (throws)', () =>
        expect(() => sanitizeAuditPayload(v, 'strict')).toThrow(),
      ),
    ).toBeLessThan(250);
  });
  it('guard: 500 strings of 8 000 digits (scan-cost budget)', () => {
    const v: Record<string, string> = {};
    for (let i = 0; i < 500; i++) v[`k${i}`] = '1'.repeat(8_000);
    expect(
      timed('guard 500 x 8000 digits, lenient', () =>
        sanitizeAuditPayload(v, 'lenient'),
      ),
    ).toBeLessThan(800);
  });
  it('guard: 500 strings of 8 000 digits under many keys of 256 digits', () => {
    const v: Record<string, string> = {};
    for (let i = 0; i < 500; i++)
      v[`${i}`.padEnd(256, '1')] = '1'.repeat(8_000);
    expect(
      timed('guard 500 keys x 256 + 500 x 8000, lenient', () =>
        sanitizeAuditPayload(v, 'lenient'),
      ),
    ).toBeLessThan(800);
  });
  it('log redactor: a 100 000-digit string, as an object, as an Error, 500 strings', () => {
    expect(
      timed('redactString 100000 digits', () =>
        redactString('1'.repeat(100_000)),
      ),
    ).toBeLessThan(150);
    expect(
      timed('redactDeep 100000 digits', () =>
        redactDeep({ a: '1'.repeat(100_000) }),
      ),
    ).toBeLessThan(150);
    expect(
      timed('redactDeep Error with 100000 digits', () =>
        redactDeep(new Error('1'.repeat(100_000))),
      ),
    ).toBeLessThan(150);
    const many: Record<string, string> = {};
    for (let i = 0; i < 500; i++) many[`k${i}`] = '1'.repeat(8_000);
    expect(
      timed('redactDeep 500 x 8000 digits', () => redactDeep(many)),
    ).toBeLessThan(400);
    expect(
      timed('redactDeep 150000-char key', () =>
        redactDeep({ ['1'.repeat(150_000)]: 1 }),
      ),
    ).toBeLessThan(150);
  });
});
