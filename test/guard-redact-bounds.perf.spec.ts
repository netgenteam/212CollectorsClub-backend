import { describe, expect, it } from 'vitest';
import { redactDeep, redactString } from './../src/common/redact.js';
import {
  redactText,
  sanitizeAuditPayload,
} from './../src/audit/audit-payload.js';
import {
  isIdDocKey,
  looksLikeIdDocInText,
} from './../src/common/id-doc-not-in-url.js';

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

/**
 * QA round 3: `redactString('idDoc'.repeat(n))` was CUBIC under the caps (1 000 characters 239 ms,
 * 4 000 characters 7.5 s, 8 000 characters more than 20 s; `redactDeep({ err: 'idDoc'.repeat(600) })`
 * blocked 3.9 s), on every log line, in the main thread. Every pass is linear or bounded now. The
 * fuzz below builds a 60 000-character string out of each unit (the repeated shapes that hit a
 * backtracking pattern: field names, separators, quotes, `Key (`, labels, runs of spaces / digits /
 * dots / `@`) and fixes a ceiling for the redactor, the guard detectors and the query-string check.
 */
const FUZZ_UNITS = [
  'a',
  '1',
  '1.',
  '12.345.',
  ' ',
  '@',
  'a@',
  'a@b.',
  '.',
  '-',
  '_',
  '$',
  '\\',
  '"',
  "'",
  '`',
  '[',
  ']',
  '(',
  ')',
  ')=(',
  'Key (',
  'Key (idDoc)=(',
  '%3D',
  'idDoc',
  'idDoc:',
  'idDoc: ',
  'idDoc: "',
  "idDoc='",
  'idDoc=`',
  'idDoc[0]=',
  'idDocEnc => ',
  'idDoc12345678',
  'IDDOC',
  'id_doc',
  'recipientIdDoc',
  'recipientIdDocBlind: 1',
  'buyerId=',
  'cedula',
  'cedula ',
  'cedula:',
  'cedula  ',
  'ci',
  'ci ',
  'ci    ',
  'ci:    ',
  'C.I. ',
  'rif ',
  'V-',
  'V',
  'V 1',
  'P-',
  'P-A',
  'pasaporte ',
  'v1:',
  'v1:aaaaaaaaaaaaaaaa:',
  'v1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbb:',
  'token=',
  'api_key=',
  'password ',
  'Bearer ',
  'Bearer a',
  'eyJ.',
  'eyJabcd.',
  '+1 ',
  '+58',
  '0412',
  '0412 ',
  '4111 ',
  'aA',
  'Aa',
  'AA',
  'x@y',
  '\u00e9',
  '\u0301',
  '\uff36',
  '\n',
];
const FUZZ_CHARS = 60_000;
const FUZZ_CEILING_MS = 150;

describe('bounded work: fuzz of repeated shapes (no catastrophic backtracking)', () => {
  const inputs = FUZZ_UNITS.map((u) => ({
    unit: u,
    text: u.repeat(Math.ceil(FUZZ_CHARS / u.length)).slice(0, FUZZ_CHARS),
  }));

  it('the exact cases of the QA report', () => {
    for (const n of [200, 800, 1600, 6000]) {
      expect(
        timed(`redactString idDoc x${n} (${n * 5} chars)`, () =>
          redactString('idDoc'.repeat(n)),
        ),
      ).toBeLessThan(50);
    }
    for (const field of [
      'cedula',
      'buyerId',
      'recipientId',
      'id_doc',
      'idDoc$',
    ]) {
      expect(
        timed(`redactDeep { err: ${field} x600 }`, () =>
          redactDeep({ err: field.repeat(600) }),
        ),
      ).toBeLessThan(50);
    }
  });

  it(`redactString / redactDeep: ${FUZZ_CHARS} characters of each shape under ${FUZZ_CEILING_MS} ms`, () => {
    let worst = 0;
    let worstUnit = '';
    for (const { unit, text } of inputs) {
      for (const run of [
        () => redactString(text),
        () => redactDeep({ message: text, [text.slice(0, 300)]: 1 }),
      ]) {
        const t0 = nowMs();
        run();
        const ms = nowMs() - t0;
        if (ms > worst) {
          worst = ms;
          worstUnit = unit;
        }
        expect(ms, `unit ${JSON.stringify(unit)}`).toBeLessThan(
          FUZZ_CEILING_MS,
        );
      }
    }
    console.info(
      `redactor fuzz: worst ${worst.toFixed(1)} ms (${JSON.stringify(worstUnit)})`,
    );
  });

  it(`guard detectors (redactText): ${FUZZ_CHARS} characters of each shape under ${FUZZ_CEILING_MS} ms`, () => {
    let worst = 0;
    let worstUnit = '';
    for (const { unit, text } of inputs) {
      const t0 = nowMs();
      redactText(text);
      const ms = nowMs() - t0;
      if (ms > worst) {
        worst = ms;
        worstUnit = unit;
      }
      expect(ms, `unit ${JSON.stringify(unit)}`).toBeLessThan(FUZZ_CEILING_MS);
    }
    console.info(
      `guard fuzz: worst ${worst.toFixed(1)} ms (${JSON.stringify(worstUnit)})`,
    );
  });

  it(`assertNoIdDocInQuery building blocks: ${FUZZ_CHARS} characters of each shape under ${FUZZ_CEILING_MS} ms`, () => {
    let worst = 0;
    let worstUnit = '';
    for (const { unit, text } of inputs) {
      const t0 = nowMs();
      looksLikeIdDocInText(text);
      isIdDocKey(text);
      const ms = nowMs() - t0;
      if (ms > worst) {
        worst = ms;
        worstUnit = unit;
      }
      expect(ms, `unit ${JSON.stringify(unit)}`).toBeLessThan(FUZZ_CEILING_MS);
    }
    console.info(
      `query-check fuzz: worst ${worst.toFixed(1)} ms (${JSON.stringify(worstUnit)})`,
    );
  });

  it('the guard on a whole payload: 15 000-character values and 256-character keys, lenient', () => {
    const v: Record<string, string> = {};
    for (let i = 0; i < 12; i++)
      v[`${i}`.padEnd(256, 'k')] = `${'a@'.repeat(4000)} x`;
    expect(
      timed('guard 12 keys x 256 + 12 x 8000 of a@', () =>
        sanitizeAuditPayload(v, 'lenient'),
      ),
    ).toBeLessThan(400);
  });
});
