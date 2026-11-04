import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { looksLikeIdDoc } from './id-doc-pattern.js';
import {
  REDACTED,
  REDACTED_ID_DOC,
  redactDeep,
  redactString,
} from './redact.js';

const SENTINEL = 'V-98765432';

describe('redactString (AC7)', () => {
  it.each([
    'V-98765432',
    'v98765432',
    'V 98765432',
    'V-98.765.432',
    'v 98 765 432'.replace('98 765 432', '98.765.432'),
    'J-12345678-9',
    'E-1234567',
    'G200000031',
    'P-123456',
  ])('redacts %s', (id) => {
    const out = redactString(`cliente ${id}, factura`);
    expect(out).toBe(`cliente ${REDACTED_ID_DOC}, factura`);
  });

  it('redacts several occurrences and ones next to punctuation', () => {
    expect(redactString('a=V-98765432;b=(E-12345678).')).toBe(
      `a=${REDACTED_ID_DOC};b=(${REDACTED_ID_DOC}).`,
    );
    expect(redactString('V-98765432 y V-98765433')).toBe(
      `${REDACTED_ID_DOC} y ${REDACTED_ID_DOC}`,
    );
  });

  it('is repeatable (no shared lastIndex state)', () => {
    for (let i = 0; i < 5; i++)
      expect(redactString('V-98765432')).toBe(REDACTED_ID_DOC);
  });

  it('does not touch UUIDs, dates, amounts, hashes, ids and words', () => {
    const safe = [
      randomUUID(),
      'e1234567-89ab-4cde-8f01-23456789abcd',
      'E1234567-0000-4000-8000-000000000000',
      'a1b2-e12345678-x',
      '2026-11-03',
      '2026-11-03T20:08:33.123Z',
      '$1.234.567,89',
      'total=1234567.89 USD',
      'EUR 1.234,50',
      'order 4821 total 99.50',
      'PENDING12345',
      'sha256:' + 'e12345678abcdef'.repeat(4),
      'GET /api/v1/products?page=12345',
      'tel 04121234567',
      'timestamp 1730664513123',
      'V-1234',
    ];
    for (const s of safe) expect(redactString(s), s).toBe(s);
  });

  it('handles empty, huge and weird strings', () => {
    expect(redactString('')).toBe('');
    expect(redactString('x'.repeat(1_000_000))).toHaveLength(1_000_000);
    const long = 'linea V-98765432 ok '.repeat(50_000);
    expect(redactString(long)).not.toContain('98765432');
    expect(() => redactString('\uD800 V-98765432 \uDFFF')).not.toThrow();
  });
});

describe('redactDeep (AC7)', () => {
  it('masks sensitive keys at any depth, in arrays and in nested objects', () => {
    const input = {
      ok: 1,
      recipientIdDoc: SENTINEL,
      nested: {
        buyerIdNumber: '1',
        deep: [{ idDoc: SENTINEL, keep: 'x' }, { cedula: 5 }],
      },
      list: [
        { password: 'p' },
        { Authorization: 'Bearer abc' },
        { 'set-cookie': 'a=b' },
      ],
      accessToken: 't',
      IDDOC_ENC_KEYS: '1:abc',
      clientSecret: 's',
    };
    const out = redactDeep(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SENTINEL);
    expect(out.recipientIdDoc).toBe(REDACTED);
    expect(out.nested.buyerIdNumber).toBe(REDACTED);
    expect(out.nested.deep[0]).toEqual({ idDoc: REDACTED, keep: 'x' });
    expect(out.nested.deep[1]).toEqual({ cedula: REDACTED });
    expect(out.list).toEqual([
      { password: REDACTED },
      { Authorization: REDACTED },
      { 'set-cookie': REDACTED },
    ]);
    expect(out.accessToken).toBe(REDACTED);
    expect(out.IDDOC_ENC_KEYS).toBe(REDACTED);
    expect(out.clientSecret).toBe(REDACTED);
    expect(out.ok).toBe(1);
  });

  it('redacts cedula-shaped strings under harmless keys, and keeps UUID/date/amount values', () => {
    const id = randomUUID();
    const out = redactDeep({
      note: `entregar a ${SENTINEL}`,
      id,
      at: '2026-11-03',
      total: '1.234.567,89',
      arr: [`x ${SENTINEL}`, 5, null, undefined, true],
      when: new Date('2026-11-03T00:00:00Z'),
    });
    expect(out.note).toBe(`entregar a ${REDACTED_ID_DOC}`);
    expect(out.id).toBe(id);
    expect(out.at).toBe('2026-11-03');
    expect(out.total).toBe('1.234.567,89');
    expect(out.arr).toEqual([`x ${REDACTED_ID_DOC}`, 5, null, undefined, true]);
    expect(out.when).toBeInstanceOf(Date);
  });

  it('does not mutate the input and handles scalars, null, undefined', () => {
    const input = { idDoc: SENTINEL, a: [SENTINEL] };
    const copy = JSON.parse(JSON.stringify(input)) as typeof input;
    redactDeep(input);
    expect(input).toEqual(copy);
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
    expect(redactDeep(5)).toBe(5);
    expect(redactDeep(SENTINEL)).toBe(REDACTED_ID_DOC);
  });

  it('survives cycles, shared references, deep nesting, huge graphs and throwing getters', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactDeep(a).self).toBe('[Circular]');
    const shared = { v: SENTINEL };
    const out = redactDeep({ x: shared, y: shared });
    expect(out.x.v).toBe(REDACTED_ID_DOC);
    expect(out.y.v).toBe(REDACTED_ID_DOC);
    let deep: Record<string, unknown> = { leaf: SENTINEL };
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(JSON.stringify(redactDeep(deep))).not.toContain(SENTINEL);
    const big = Array.from({ length: 50_000 }, (_, i) => ({ i, n: SENTINEL }));
    expect(JSON.stringify(redactDeep(big))).not.toContain(SENTINEL);
    const bad = {
      get boom(): string {
        throw new Error('nope');
      },
      ok: 1,
    };
    expect(redactDeep(bad)).toEqual({ boom: '[Unreadable]', ok: 1 });
  });

  it('redacts an Error: message, stack and own props (e.g. a Prisma error echoing a value)', () => {
    const err = Object.assign(
      new Error(`Invalid value for argument id: ${SENTINEL}`),
      {
        code: 'P2023',
        meta: {
          target: ['recipientIdDoc'],
          value: SENTINEL,
          text: `dup ${SENTINEL}`,
        },
      },
    );
    const json = JSON.stringify(redactDeep(err));
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain('P2023');
  });
});

describe('shared ID pattern', () => {
  it('looksLikeIdDoc is the same definition the redactor uses', () => {
    for (const v of [
      'V-12345678',
      'v12345678',
      ' E-1234567 ',
      'J-12345678-9',
      'V-12.345.678',
      'G200000031',
    ]) {
      expect(looksLikeIdDoc(v), v).toBe(true);
      expect(redactString(v.trim())).toBe(REDACTED_ID_DOC);
    }
    for (const v of [
      'V-1234',
      'hello',
      randomUUID(),
      '2026-11-03',
      'PENDING12345',
      '12345678',
      'V-12345678 y mas',
    ]) {
      expect(looksLikeIdDoc(v), v).toBe(false);
    }
  });
});
