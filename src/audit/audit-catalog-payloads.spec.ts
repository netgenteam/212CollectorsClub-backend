import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  publicFieldsOf,
  type AuditAction,
} from './audit-actions.js';
import {
  AuditPayloadError,
  auditBigInt,
  auditDate,
  auditDecimal,
  sanitizeAuditPayload,
  toAuditPayload,
} from './audit-payload.js';
import type { AuditPayload } from './audit-payload.js';

const run = (
  action: AuditAction,
  v: unknown,
  mode: 'strict' | 'lenient',
  path = '$after',
) => sanitizeAuditPayload(v, mode, path, publicFieldsOf(action));

const uuid = () => randomUUID();
const sha = 'f'.repeat(64);

/**
 * One representative payload per action, written from the stories 20.4-20.8
 * (what the emitters will really send). Typed as a Record over the catalog:
 * a new action does not compile until it has a sample here, so the guard is
 * proven against every action before its emitter exists.
 */
const SAMPLES: Record<AuditAction, AuditPayload[]> = {
  LOGIN_ADMIN_OK: [{ adminId: uuid(), method: 'password', sessionId: uuid() }],
  LOGIN_ADMIN_FAILED: [
    { emailHash: sha, reason: 'BAD_PASSWORD', attempt: 3, adminFound: false },
  ],
  LOGOUT_ADMIN: [{ sessionId: uuid() }],
  ADMIN_CREDENTIALS_CHANGED: [
    { passwordChanged: true, emailHash: sha, sessionsRevoked: 2 },
  ],
  ADMIN_ROLE_CHANGED: [{ role: 'ADMIN', previousRole: 'EDITOR' }],
  ADMIN_CREATED: [{ emailHash: sha, role: 'ADMIN', createdBy: uuid() }],
  ADMIN_DISABLED: [{ emailHash: sha, disabled: true }],
  CUSTOMER_ANONYMIZED: [
    { emailHash: sha, addressesDeleted: 3, sessionsRevoked: 1 },
  ],
  ID_DOC_REVEALED: [
    { field: 'buyer', orderId: uuid(), idDocType: 'V', revealedInHour: 7 },
  ],
  PAYMENT_PAGO_MOVIL_CONFIRMED: [
    {
      orderId: uuid(),
      orderStatus: 'PAID',
      previousStatus: 'PENDING_VERIFICATION',
      proofId: uuid(),
      amountUsd: '12.50',
      amountVes: '4567.80',
      fxRate: '365.4000',
      reference: '0012345678',
      pagoMovilBank: 'Banesco',
      stockCommitted: 3,
    },
  ],
  PAYMENT_PAGO_MOVIL_REJECTED: [
    {
      orderId: uuid(),
      orderStatus: 'PAYMENT_REJECTED',
      reason: 'AMOUNT_MISMATCH',
      pagoMovilBank: 'Mercantil',
      holdsReleased: 2,
    },
  ],
  STRIPE_PAYMENT_STATE_CHANGED: [
    {
      eventId: 'evt_1QxYz1AbCdEf2GhIjKlMnOpQ',
      paymentIntentId: 'pi_3QxYz1AbCdEf2GhIj_secretless',
      checkoutSessionId: 'cs_test_a1B2c3D4e5F6g7H8i9J0',
      from: 'PAYMENT_PROCESSING',
      to: 'PAID',
      amountUsd: '150.00',
    },
  ],
  REFUND_ISSUED: [
    { refundId: 're_3QxYz1AbCdEf', orderId: uuid(), amountUsd: '15.00' },
  ],
  ORDER_STATUS_CHANGED: [
    { from: 'PAID', to: 'FULFILLED', orderId: uuid(), historyId: uuid() },
  ],
  ORDER_TRACKING_CHANGED: [
    {
      carrier: 'MRW',
      trackingNumber: 'MRW0012345678',
      trackingUrl: 'https://mrw.com.ve/seguimiento?num=MRW0012345678',
      status: 'SHIPPED',
    },
  ],
  PRODUCT_PRICE_CHANGED: [
    { productId: uuid(), priceUsd: '12.50', previousPriceUsd: '10.00' },
  ],
  PRODUCT_STOCK_ADJUSTED: [
    { productId: uuid(), stock: 5, previousStock: 9, delta: -4 },
  ],
  FX_SOURCE_CHANGED: [{ source: 'MANUAL', previousSource: 'BCV' }],
  FX_RATE_CHANGED: [
    { rate: '365.4000', previousRate: '360.1000', source: 'MANUAL' },
  ],
  VITRINA_CONFIG_CHANGED: [
    {
      mode: 'AUTO',
      weights: { views: 3, wishlist: 5, sales: 8 },
      pinned: [uuid(), uuid()],
      changedKeys: ['mode', 'weights'],
    },
  ],
  LEGAL_DOC_PUBLISHED: [
    {
      documentId: uuid(),
      kind: 'TERMS',
      version: 3,
      effectiveFrom: '2026-11-04T10:00:00.000Z',
      contentHash: sha,
    },
  ],
  SELLER_IDENTITY_UPDATED: [
    {
      legalName: 'Collectors Club C.A.',
      rif: 'J-12345678-9',
      fiscalAddress: 'Av. Principal, Edif. Centro, Caracas',
      contactEmail: 'ventas@collectors.example',
      phone: '+58 212 555 1234',
    },
    {
      sellerRif: 'J-123456789',
      sellerEmail: 'ventas@collectors.example',
      sellerPhone: '0212-555-1234',
      legalAddress: 'Av. Principal',
      address: 'Av. Principal',
      phoneCountry: '+58',
      pagoMovilPhone: '0414-555-1234',
      pagoMovilBank: 'Banesco',
      pagoMovilRif: 'J-12345678-9',
    },
    { rif: null, phone: null, changedFields: ['rif', 'phone'] },
  ],
  CONSENT_RECORDED: [
    {
      consentRecordIds: [uuid(), uuid(), uuid()],
      versions: { terms: 3, privacy: 2, returns: 1 },
      orderId: uuid(),
    },
  ],
  DATA_EXPORTED: [{ kind: 'ORDERS_CSV', rows: 1200, from: '2026-10-01' }],
  SHIPPING_AGENCY_CHANGED: [
    {
      agencyId: uuid(),
      name: 'MRW',
      code: 'mrw',
      isActive: true,
      trackingUrlTemplate: 'https://mrw.example/t/{trackingNumber}',
      branches: [
        { name: 'Sucursal Chacao', address: 'Av. Francisco de Miranda' },
      ],
    },
  ],
  RETENTION_PURGE_RUN: [
    {
      runId: uuid(),
      trigger: 'SCHEDULED',
      status: 'OK',
      tasks: [
        { name: 'session_pii', rows: 1500, durationMs: 420, truncated: false },
        { name: 'usage_logs', rows: 0, durationMs: 12, truncated: false },
      ],
    },
  ],
  DATA_MIGRATION_RUN: [
    { mode: 'backfill', scanned: 100, encrypted: 98, failed: 0, batches: 1 },
  ],
  AUDIT_VERIFIED: [
    { mode: 'full', result: 'OK', rows: 121, fromSeq: 1, toSeq: 121 },
  ],
};

describe('catalog: representative payloads of Stories 20.4-20.8 pass in BOTH modes', () => {
  it('has a sample for every action (the Record type enforces it at compile time)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      Object.keys(AUDIT_ACTIONS).sort(),
    );
  });

  for (const action of Object.keys(SAMPLES) as AuditAction[]) {
    it(`${action}`, () => {
      for (const sample of SAMPLES[action]) {
        const s = run(action, sample, 'strict');
        expect(s.value).toEqual(sample);
        const l = run(action, sample, 'lenient');
        expect(l.issues).toEqual([]); // nothing masked: the event keeps its content
        expect(l.value).toEqual(sample);
      }
    });
  }

  it('ids and timestamps never trip a value detector (fuzz)', () => {
    for (let i = 0; i < 3000; i += 1) {
      const p = {
        id: uuid(),
        at: new Date(Date.now() - i * 86_400_000 * 3.7).toISOString(),
        ref: `ORD-${String(i).padStart(8, '0')}`,
        amount: `${i}.${String(i % 100).padStart(2, '0')}`,
      };
      expect(() => run('ORDER_STATUS_CHANGED', p, 'strict')).not.toThrow();
    }
  });
});

describe('public seller fields: explicit per action, never general', () => {
  const seller = {
    rif: 'J-12345678-9',
    sellerRif: 'J-12345678-9',
    address: 'Av. Principal',
    sellerEmail: 'ventas@collectors.example',
    sellerPhone: '+58 212 555 1234',
    legalAddress: 'Av. Principal',
    pagoMovilPhone: '0414-555-1234',
    phoneCountry: '+58',
    pagoMovilBank: 'Banesco',
  };

  it('the guard alone (no allowance) still rejects every one of them, in strict mode', () => {
    for (const [k, v] of Object.entries(seller)) {
      expect(() => sanitizeAuditPayload({ [k]: v }, 'strict')).toThrow(
        AuditPayloadError,
      );
    }
  });

  it('SELLER_IDENTITY_UPDATED carries them, in both modes', () => {
    expect(run('SELLER_IDENTITY_UPDATED', seller, 'strict').value).toEqual(
      seller,
    );
    const l = run('SELLER_IDENTITY_UPDATED', seller, 'lenient');
    expect(l.issues).toEqual([]);
    expect(l.value).toEqual(seller);
  });

  it.each([
    'CUSTOMER_ANONYMIZED',
    'ORDER_STATUS_CHANGED',
    'ORDER_TRACKING_CHANGED',
    'ID_DOC_REVEALED',
    'CONSENT_RECORDED',
    'LOGIN_ADMIN_FAILED',
    'DATA_EXPORTED',
  ] as const)('%s keeps rejecting them (strict throws, lenient masks)', (a) => {
    for (const [k, v] of Object.entries(seller)) {
      expect(() => run(a, { [k]: v }, 'strict')).toThrow(AuditPayloadError);
      const l = run(a, { [k]: v }, 'lenient');
      expect(l.issues.length).toBeGreaterThan(0);
      expect(l.value).toEqual({ [k]: '[REDACTED:KEY]' });
    }
  });

  it('Pago Movil payments allow only the bank name, nothing else of the list', () => {
    expect(() =>
      run(
        'PAYMENT_PAGO_MOVIL_CONFIRMED',
        { pagoMovilBank: 'Banesco' },
        'strict',
      ),
    ).not.toThrow();
    for (const k of ['pagoMovilPhone', 'rif', 'address', 'phone', 'cedula']) {
      expect(() =>
        run('PAYMENT_PAGO_MOVIL_CONFIRMED', { [k]: 'x' }, 'strict'),
      ).toThrow(AuditPayloadError);
    }
  });

  it('a customer cedula/idDoc/ID shaped value is still rejected inside the seller action', () => {
    for (const bad of [
      { cedula: 'V-12345678' },
      { idDoc: 'V-12345678' },
      { buyerIdDoc: 'x' },
      { recipientIdDoc: 'x' },
      { documento: 'x' },
      { email: 'a@b.com' }, // the customer-style key is not in the list
      { telefono: '1' },
      { password: 'x' },
      { token: 'x' },
      { Rif: 'J-12345678-9' }, // exact, case-sensitive
      { 'rif ': 'J-12345678-9' },
    ]) {
      expect(() => run('SELLER_IDENTITY_UPDATED', bad, 'strict')).toThrow(
        AuditPayloadError,
      );
    }
  });

  it('a public field is exempt only from ITS classes: a customer cedula/card/secret in `phone` or `rif` is still caught', () => {
    for (const bad of [
      { rif: 'maria@example.com' }, // rif may look like a cedula, not like an email
      { phone: 'V-12345678' }, // phone may look like a phone, not like a cedula
      { contactEmail: '+58 414 555 1234' },
      { phone: 'sk_live_abcdef123456' },
      { legalName: 'V-12345678' }, // not exempt at all
      { fiscalAddress: 'maria@example.com' },
      { address: '4111 1111 1111 1111' },
      { sellerEmail: 'eyJhbGciOi.eyJzdWIiOi.abc' },
    ]) {
      expect(() => run('SELLER_IDENTITY_UPDATED', bad, 'strict')).toThrow(
        AuditPayloadError,
      );
      const l = run('SELLER_IDENTITY_UPDATED', bad, 'lenient');
      expect(l.issues.length).toBeGreaterThan(0);
    }
  });

  it('a public field holds text or null only: an object/array under it is rejected and cannot smuggle keys', () => {
    for (const bad of [
      { rif: { cedula: 'V-12345678' } },
      { address: ['maria@example.com'] },
      { phone: 5 },
    ]) {
      expect(() => run('SELLER_IDENTITY_UPDATED', bad, 'strict')).toThrow(
        /public field/,
      );
      const l = run('SELLER_IDENTITY_UPDATED', bad, 'lenient');
      expect(JSON.stringify(l.value)).not.toMatch(/maria|12345678/);
    }
  });

  it('the allowance does not leak by prototype keys', () => {
    for (const k of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(() =>
        run('ORDER_STATUS_CHANGED', JSON.parse(`{"${k}":"x"}`), 'strict'),
      ).not.toThrow(/personal data/);
    }
    expect(publicFieldsOf('ORDER_STATUS_CHANGED')).toBeUndefined();
    expect(publicFieldsOf('CUSTOMER_ANONYMIZED')).toBeUndefined();
  });

  // A POSITIVE list: a new action (or any existing one) with `publicFields` fails here until a
  // reviewer adds it on purpose. (A deny list by prefix let `STRIPE_PAYMENT_STATE_CHANGED`
  // declare one with every test green.)
  const MAY_DECLARE_PUBLIC_FIELDS: readonly AuditAction[] = [
    'PAYMENT_PAGO_MOVIL_CONFIRMED',
    'PAYMENT_PAGO_MOVIL_REJECTED',
    'SELLER_IDENTITY_UPDATED',
    'SHIPPING_AGENCY_CHANGED',
  ];

  it('only the allow-listed actions declare publicFields (guard rail on the catalog)', () => {
    const withAllowance = (Object.keys(AUDIT_ACTIONS) as AuditAction[])
      .filter((a) => publicFieldsOf(a) !== undefined)
      .sort();
    expect(withAllowance).toEqual([...MAY_DECLARE_PUBLIC_FIELDS].sort());
  });

  it('no declared path names a secret or an identity document', () => {
    for (const a of Object.keys(AUDIT_ACTIONS) as AuditAction[]) {
      const pf = publicFieldsOf(a) ?? {};
      for (const k of Object.keys(pf)) {
        expect(k, `${a}.${k}`).not.toMatch(
          /cedula|iddoc|passport|pasaporte|password|token|secret|dni/i,
        );
      }
    }
  });

  it('publicFields apply at the FIRST level only, or at a declared full path', () => {
    const rif = { rif: 'V-12345678', address: 'Av. Principal 1' };
    // first level: allowed on the seller action
    expect(() => run('SELLER_IDENTITY_UPDATED', rif, 'strict')).not.toThrow();
    // one level down: the same keys are NOT exempt (a customer's data can look like this)
    for (const nested of [
      { customer: rif },
      { customer: { profile: rif } },
      { list: [rif] },
      { branches: [{ address: 'Av. Principal 1' }] },
    ]) {
      expect(() => run('SELLER_IDENTITY_UPDATED', nested, 'strict')).toThrow(
        /personal data|looks like|key/i,
      );
    }
    // lenient mode redacts instead
    const r = sanitizeAuditPayload(
      { customer: rif },
      'lenient',
      '$',
      publicFieldsOf('SELLER_IDENTITY_UPDATED'),
    );
    expect(JSON.stringify(r.value)).not.toContain('V-12345678');
    expect(r.issues.length).toBeGreaterThan(0);
    // a declared full path (what a story would add for `branches[].address`) works, and only there
    const declared = { 'branches[].address': [] } as const;
    const ok = sanitizeAuditPayload(
      { branches: [{ address: 'Av. Principal 1' }] },
      'strict',
      '$',
      declared,
    );
    expect(ok.value).toEqual({ branches: [{ address: 'Av. Principal 1' }] });
    expect(() =>
      sanitizeAuditPayload(
        { other: [{ address: 'Av. Principal 1' }] },
        'strict',
        '$',
        declared,
      ),
    ).toThrow();
    expect(() =>
      sanitizeAuditPayload(
        { address: 'Av. Principal 1' },
        'strict',
        '$',
        declared,
      ),
    ).toThrow();
    // a key with a dot is one segment, not a path
    expect(() =>
      sanitizeAuditPayload(
        { 'branches[]': { address: 'Av. Principal 1' } },
        'strict',
        '$',
        declared,
      ),
    ).toThrow();
  });
});

describe('a sensitive KEY never reaches the path of an error or a warning', () => {
  const secrets = [
    'z@z.com',
    'maria.perez@example.com',
    'sk_live_abcdefghijklmnop',
    'V-12345678',
    '+58 414 555 1234',
  ];

  it('strict: the thrown message masks the key', () => {
    for (const k of secrets) {
      let msg = '';
      try {
        sanitizeAuditPayload({ outer: { [k]: 1 } }, 'strict');
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, k).toMatch(/Invalid audit payload/);
      expect(msg, k).not.toContain(k);
      expect(msg, k).toMatch(/\[REDACTED:/);
    }
  });

  it('lenient: neither the issues nor the repaired value carry the key', () => {
    for (const k of secrets) {
      const l = sanitizeAuditPayload({ outer: { [k]: 1 } }, 'lenient');
      const dump = JSON.stringify(l);
      expect(dump, k).not.toContain(k);
      expect(l.issues[0].path).toMatch(/^\$\.outer\.\[REDACTED:/);
    }
  });

  it('a huge key is capped in the path', () => {
    const l = sanitizeAuditPayload(
      { ['k'.repeat(5000)]: 1, email: 'x' },
      'lenient',
    );
    expect(l.issues.every((i) => i.path.length < 200)).toBe(true);
  });
});

describe('Date / BigInt / Decimal: a bug in both modes, with helpers to avoid it', () => {
  const decimal = {
    toFixed: () => '12.5000',
    isNaN: () => false,
    constructor: { name: 'Decimal' },
  };
  class Decimal {
    toFixed(): string {
      return '12.5000';
    }
  }

  it('throws in strict and lenient, naming the helper', () => {
    for (const mode of ['strict', 'lenient'] as const) {
      expect(() => sanitizeAuditPayload({ d: new Date() }, mode)).toThrow(
        /auditDate/,
      );
      expect(() => sanitizeAuditPayload({ b: 1n }, mode)).toThrow(
        /auditBigInt/,
      );
      expect(() => sanitizeAuditPayload({ m: new Decimal() }, mode)).toThrow(
        /auditDecimal/,
      );
    }
    void decimal;
  });

  it('helpers and toAuditPayload convert them to strings', () => {
    const d = new Date('2026-11-04T10:00:00.123Z');
    expect(auditDate(d)).toBe('2026-11-04T10:00:00.123Z');
    expect(() => auditDate(new Date('x'))).toThrow(AuditPayloadError);
    expect(auditBigInt(9007199254740993n)).toBe('9007199254740993');
    expect(auditDecimal(new Decimal())).toBe('12.5000');
    const row = {
      id: uuid(),
      price: new Decimal(),
      at: d,
      big: 5n,
      nested: [{ when: d, skip: undefined }],
      none: null,
    };
    const p = toAuditPayload(row);
    expect(p).toEqual({
      id: row.id,
      price: '12.5000',
      at: '2026-11-04T10:00:00.123Z',
      big: '5',
      nested: [{ when: '2026-11-04T10:00:00.123Z' }],
      none: null,
    });
    for (const mode of ['strict', 'lenient'] as const) {
      expect(() => sanitizeAuditPayload(p, mode)).not.toThrow();
    }
  });
});
