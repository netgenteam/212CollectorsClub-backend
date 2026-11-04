import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditPayloadError,
  auditPayloadMode,
  keyViolation,
  redactReason,
  redactText,
  sanitizeAuditPayload,
} from './audit-payload.js';

const strict = (v: unknown) => sanitizeAuditPayload(v, 'strict').value;
const lenient = (v: unknown) => sanitizeAuditPayload(v, 'lenient');

/** Story 20.1, QA round 2: false positives (a sale must not break) and false negatives (PII in an immutable log). */
describe('PII / secret guard: values that must NOT be flagged (false positives)', () => {
  it.each([
    'P-12345',
    'V-100000',
    'E-123456',
    'G-12345',
    'P-123456',
    'V-1234',
    'SKU-12345678',
    'PROD-V-12345678',
    'e1234567-89ab-4cde-8f01-23456789abcd',
    '2026-11-03',
    '2026-11-03T12:30:00.000Z',
    'PENDING12345',
    'a'.repeat(64),
    'pi_3QxYz1AbCdEf2GhIj',
    'cs_test_a1B2c3D4',
    're_1234567890',
    '10.50',
    '1234.56',
    '1.234.567,89',
    '1730678400000',
    '20261103',
    'Bearer',
    'a bearer of bad news',
    'secretary of state',
    'token expired',
    'order 123456 shipped',
    'user@host',
  ])('%s', (v) => {
    expect(() => strict({ note: v })).not.toThrow();
    expect(strict({ note: v })).toEqual({ note: v });
  });

  it.each([
    'addressId',
    'ipAddress',
    'macAddress',
    'emailVerified',
    'emailVerifiedAt',
    'tokensIssued',
    'secretary',
    'passwordChanged',
    'passwordChangedAt',
    'emailHash',
    'idDocHash',
    'userId',
    'documentId',
    'documentSlug',
    'legalDocument',
    'status',
    'cardBrand',
    'cardLast4',
    'ip',
    'mailer',
    'mailbox',
  ])('key %s', (k) => {
    expect(keyViolation(k)).toBeNull();
    expect(() => strict({ [k]: 'x' })).not.toThrow();
  });
});

describe('PII / secret guard: values that MUST be flagged (false negatives)', () => {
  it.each([
    ['12.345.678', 'bare dotted cedula'],
    ['V-12345678', 'cedula'],
    ['V 12345678', 'cedula, space'],
    ['v-12.345.678', 'cedula dotted'],
    ['E1234567', 'cedula E, 7 digits'],
    ['J-12345678-9', 'RIF'],
    ['J123456789', 'RIF contiguous'],
    ['G-20000001-0', 'RIF G'],
    ['P-12345678', 'passport'],
    ['mi cédula es V-12345678 gracias', 'cedula in free text'],
    ['cédula: 12.345.678', 'keyword + dotted'],
    ['C.I. 12345678', 'C.I.'],
    ['RIF 123456789', 'RIF keyword'],
    ['dni 12345678', 'dni'],
    ['0412-1234567', 'VE mobile'],
    ['04141234567', 'VE mobile compact'],
    ['0212 123 4567', 'VE landline'],
    ['+58 412 1234567', 'international'],
    ['+584121234567', 'international compact'],
    ['584121234567', '58 prefix'],
    ['(555) 123-4567', 'US'],
    ['555-123-4567', 'US dashes'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      'JWT',
    ],
    ['sk_live_51Habc', 'Stripe live key'],
    ['sk_test_51Habc', 'Stripe test key'],
    ['sk_live_', 'sk_live_ prefix'],
    ['whsec_abcdef123456', 'webhook secret'],
    ['Authorization: Bearer abc123def456ghi', 'Bearer'],
    ['Bearer abc123def456', 'Bearer alone'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS key'],
    ['4111 1111 1111 1111', 'Visa'],
    ['4111111111111111', 'Visa compact'],
    ['5500-0000-0000-0004', 'Mastercard'],
    ['3782 822463 10005', 'Amex'],
    ['maria@example.com', 'email'],
    ['password=hunter2', 'password assignment'],
    ['api_key: sk1234567890abcd', 'api key assignment'],
    ['-----BEGIN PRIVATE KEY-----', 'PEM'],
  ])('%s (%s)', (v) => {
    expect(() => strict({ note: v })).toThrow(AuditPayloadError);
    const r = lenient({ note: v });
    expect(r.issues).toHaveLength(1);
    expect(JSON.stringify(r.value)).toContain('[REDACTED:');
  });

  it('an email (or any PII-shaped text) as a KEY', () => {
    expect(() => strict({ 'maria@example.com': 1 })).toThrow(/key looks like/);
    expect(() => strict({ 'V-12345678': 1 })).toThrow(/key looks like/);
    const r = lenient({ 'maria@example.com': 1, 'ana@example.com': 2 });
    expect(Object.keys(r.value as object)).toEqual([
      '[REDACTED:EMAIL]',
      '[REDACTED:EMAIL]#2',
    ]);
  });

  it.each([
    'correo',
    'mail',
    'dni',
    'rif',
    'documento',
    'apiKey',
    'api_key',
    'pwd',
    'email',
    'customerEmail',
    'phone',
    'telefono',
    'teléfono',
    'cedula',
    'cédula',
    'idDoc',
    'buyerIdDocEnc',
    'address',
    'shippingAddress',
    'dirección',
    'passwordHash',
    'token',
    'accessToken',
    'secret',
    'cookie',
    'authorization',
    'cardNumber',
  ])('key %s', (k) => {
    expect(keyViolation(k)).not.toBeNull();
    expect(() => strict({ [k]: 'x' })).toThrow(AuditPayloadError);
    // lenient: the action goes on, the value is gone, the key stays
    expect(lenient({ [k]: 'secret value' }).value).toEqual({
      [k]: '[REDACTED:KEY]',
    });
  });
});

describe('PII / secret guard: modes', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('strict outside production (the suite runs as NODE_ENV=test), lenient in production, override wins', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUDIT_PAYLOAD_STRICT;
    expect(auditPayloadMode()).toBe('strict');
    process.env.NODE_ENV = 'development';
    expect(auditPayloadMode()).toBe('strict');
    process.env.NODE_ENV = 'production';
    expect(auditPayloadMode()).toBe('lenient');
    process.env.AUDIT_PAYLOAD_STRICT = 'true';
    expect(auditPayloadMode()).toBe('strict');
    process.env.NODE_ENV = 'test';
    process.env.AUDIT_PAYLOAD_STRICT = 'false';
    expect(auditPayloadMode()).toBe('lenient');
  });

  it('lenient repairs instead of failing: floats and huge integers become strings, undefined is dropped, PII is masked', () => {
    const r = lenient({
      price: 10.5,
      big: Number.MAX_SAFE_INTEGER + 1,
      nan: NaN,
      gone: undefined,
      list: [1, undefined, 'a@b.co'],
      note: 'call +58 412 1234567 now',
    });
    expect(r.value).toEqual({
      price: '10.5',
      big: '9007199254740992',
      nan: 'NaN',
      list: [1, null, '[REDACTED:EMAIL]'],
      note: 'call [REDACTED:PHONE] now',
    });
    expect(r.issues.map((i) => i.path).sort()).toEqual(
      [
        '$.big',
        '$.gone',
        '$.list[1]',
        '$.list[2]',
        '$.nan',
        '$.note',
        '$.price',
      ].sort(),
    );
    // paths and reasons only: the offending value is never in the report
    expect(JSON.stringify(r.issues)).not.toMatch(/1234567|a@b\.co/);
  });

  it('code bugs throw in both modes: Date, BigInt, class instances, depth', () => {
    for (const bad of [
      { d: new Date() },
      { b: 1n },
      { c: new (class X {})() },
      { f: () => 1 },
      { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: 1 } } } } } } } } } },
    ]) {
      expect(() => sanitizeAuditPayload(bad, 'lenient')).toThrow(
        AuditPayloadError,
      );
      expect(() => sanitizeAuditPayload(bad, 'strict')).toThrow(
        AuditPayloadError,
      );
    }
  });

  it('two keys that Postgres cannot tell apart: a bug in strict mode, kept apart with a suffix in lenient mode', () => {
    const clash = { 'a\ud800': 1, 'a\ud801': 2 };
    expect(() => sanitizeAuditPayload(clash, 'strict')).toThrow(/collapse/);
    const r = sanitizeAuditPayload(clash, 'lenient');
    expect(r.value).toEqual({ 'a\ufffd': 1, 'a\ufffd#2': 2 });
    expect(r.issues).toHaveLength(1);
  });

  it('normalizes what Postgres would change: lone surrogates and NUL become U+FFFD (values and keys), -0 is 0, __proto__ stays a key', () => {
    const out = strict({
      'k\ud800': 'x\u0000y\ud83d',
      n: -0,
      ['__proto__']: 'p',
      emoji: '😀',
    }) as Record<string, unknown>;
    expect(out['k\ufffd']).toBe('x\ufffdy\ufffd');
    expect(Object.is(out.n, 0)).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toContain('__proto__');
    expect(JSON.stringify(out)).toContain('"__proto__":"p"');
    expect(out.emoji).toBe('😀');
  });

  it('redactReason masks free text in both modes and never throws', () => {
    expect(redactReason('refund for maria@example.com').text).toBe(
      'refund for [REDACTED:EMAIL]',
    );
    expect(redactReason('ok').hits).toEqual([]);
    expect(redactText('[REDACTED:EMAIL]').hits).toEqual([]); // idempotent
  });
});
