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

describe('redactString by field-name context (Story 20.3, QA of 20.2)', () => {
  const V = '12345678';
  it.each([
    ['plain key: value', 'recipientIdDoc: 12345678'],
    ['key=value', 'recipientIdDoc=12345678'],
    ['JSON', '{"recipientIdDoc":"12345678"}'],
    ['JSON with spaces', '{ "recipientIdDoc" : "12345678" }'],
    [
      'escaped JSON (JSON inside a string)',
      '{\\"recipientIdDoc\\":\\"12345678\\"}',
    ],
    ['single quotes', "recipientIdDoc: '12345678'"],
    [
      'Postgres unique key',
      'duplicate key value violates unique constraint "x_idx"\nDETAIL:  Key (recipientIdDoc)=(12345678) already exists.',
    ],
    [
      'Postgres multi-column key',
      'Key (customerId, recipientIdDoc)=(a1b2, 12345678) already exists.',
    ],
    ['buyer field', 'buyerIdDoc: 12345678'],
    ['cedula', 'cedula: 12345678'],
    ['with a space inside the value', 'recipientIdDoc: "12 345 678"'],
    [
      'Prisma-style data',
      'data: { recipientIdDoc: "12345678", recipientName: "Ana" }',
    ],
  ])('%s', (_n, line) => {
    const out = redactString(line);
    expect(out, line).not.toContain(V);
    expect(out).not.toContain('12 345 678');
  });

  it('keeps the label and the surrounding text useful', () => {
    expect(redactString('failed for recipientIdDoc: 12345678, retrying')).toBe(
      'failed for recipientIdDoc: [REDACTED], retrying',
    );
    expect(
      redactString('Key (recipientIdDoc)=(12345678) already exists.'),
    ).toBe('Key (recipientIdDoc)=([REDACTED]) already exists.');
  });

  it.each([
    ['ORD-V12345678', 'ORD-V12345678'],
    ['P-AB123456', 'P-AB123456'],
    ['P AB123456', 'cedula P AB123456 ok'],
    ['E-12345678 after a word', 'order-E-12345678'],
  ])('shapes with a prefix or letters: %s', (_n, line) => {
    expect(redactString(line)).toContain(REDACTED_ID_DOC);
    expect(redactString(line)).not.toMatch(/12345678|AB123456/);
  });

  it('the Enc / Blind columns: ciphertext and blind index never appear', () => {
    const enc =
      'v1:' + 'A'.repeat(16) + ':' + 'B'.repeat(22) + ':' + 'C'.repeat(20);
    const blind = 'ab'.repeat(32);
    expect(redactString(`recipientIdDocEnc: ${enc}`)).not.toContain('AAAA');
    expect(
      redactString(`Key (recipientIdDocBlind)=(${blind}) already exists.`),
    ).not.toContain(blind);
    expect(
      redactString(`row {"buyerIdDocBlind":"${blind}","x":1}`),
    ).not.toContain(blind);
    expect(redactString(`stored ${enc} in the row`)).toBe(
      'stored [REDACTED_ENC] in the row',
    );
  });

  it('does not touch what is not a cedula', () => {
    const safe = [
      'recipientName: Ana, municipality: Baruta',
      'order 4821 pid 1234567 PENDING1 PAYMENT2 PAGO-MOVIL-7',
      'cart e1234567-89ab-4cde-8f01-23456789abcd item a1b2-e12345678901',
      'status: v1:ok',
      'recipientIdDoc: [REDACTED]',
    ];
    for (const s of safe) expect(redactString(s), s).toBe(s);
    expect(
      redactString('recipientIdDoc: [REDACTED] and recipientIdDoc: 12345678'),
    ).toBe('recipientIdDoc: [REDACTED] and recipientIdDoc: [REDACTED]');
  });

  it('is fast on a huge line without the keywords', () => {
    const t = Date.now();
    redactString('x'.repeat(2_000_000));
    redactString('recipientIdDoc: 1 '.repeat(20_000));
    expect(Date.now() - t).toBeLessThan(1500);
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

describe('redactString: evasions found by QA of 20.3 (Story 20.3 fix)', () => {
  const V = '70123456';
  it.each([
    [
      'fullwidth letter and digits',
      'recibe \uFF36-\uFF17\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16 hoy',
    ],
    ['zero-width space inside', 'recibe V\u200B-70123456 hoy'],
    ['zero-width joiner between digits', 'recibe V-7012\u200D3456 hoy'],
    ['ci: label', 'ci: 70123456'],
    ['C.I. label', 'titular C.I. V-70123456'],
    ['cedula without colon', 'cedula 70123456 verificada'],
    ['cedula with type, no colon', 'cedula V70123456'],
    ['grouped after a label', 'ci 70.123.456'],
    ['RIF label', 'RIF J-70123456-9'],
    ['array-style key', 'body idDoc[0]=70123456'],
    ['array-style key with a name', 'recipientIdDoc[main]: 70123456'],
    ['URL-encoded =', 'GET /x?recipientIdDoc%3D70123456&a=1'],
    ['URL-encoded = lowercase', 'idDoc%3d70123456'],
    ['URL-encoded : ', 'idDoc%3A70123456'],
  ])('%s', (_n, line) => {
    const out = redactString(line);
    expect(out, line).not.toContain(V);
    expect(out, line).not.toMatch(/7012\s*3456|70\.123\.456|\uFF17/);
  });
  it('the query string after a redacted value is kept', () => {
    expect(redactString('GET /x?recipientIdDoc=70123456&page=2')).toBe(
      'GET /x?recipientIdDoc=[REDACTED]&page=2',
    );
  });
  it('harmless look-alikes stay untouched', () => {
    for (const s of [
      'iddoc:backfill started',
      'iddoc:backfill --check',
      'idDocType=V',
      'idDocType: E',
      'recipientIdDocEnc present',
      'ci 5 items',
      'cedula pending',
      'ced. v',
      'accion cifrada',
    ]) {
      expect(redactString(s), s).toBe(s);
    }
  });
  it('non-ASCII text with nothing to hide is returned as it came', () => {
    expect(redactString('Ñandú pidió café 😀')).toBe('Ñandú pidió café 😀');
  });
});
