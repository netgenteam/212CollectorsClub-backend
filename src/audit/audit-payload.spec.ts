import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, isAuditAction } from './audit-actions.js';
import { assertAuditPayload } from './audit-payload.js';

describe('assertAuditPayload: before/after never admit floats or PII (Story 20.1)', () => {
  it('accepts strings, safe integers, booleans, null and nesting of those', () => {
    expect(() =>
      assertAuditPayload({
        status: 'PAID',
        stock: 12,
        price: '10.50',
        flag: true,
        none: null,
        list: [1, 'a', { emailHash: 'ab12' }],
      }),
    ).not.toThrow();
    expect(() => assertAuditPayload(null)).not.toThrow();
  });

  it('rejects floats, NaN, huge integers, Date, BigInt, undefined, class instances', () => {
    for (const bad of [
      { price: 10.5 },
      { price: NaN },
      { n: Number.MAX_SAFE_INTEGER + 1 },
      { d: new Date() },
      { b: 1n },
      { u: undefined },
      { c: new (class X {})() },
      { f: () => 1 },
    ]) {
      expect(() => assertAuditPayload(bad)).toThrow(/Invalid audit payload/);
    }
  });

  it('rejects PII keys (email, phone, cedula, address, password, token...) and PII-shaped values', () => {
    for (const bad of [
      { email: 'x' },
      { customerEmail: 'x' },
      { phone: '1' },
      { telefono: '1' },
      { cedula: '1' },
      { idDoc: '1' },
      { buyerIdDocEnc: 'x' },
      { address: 'x' },
      { direccion: 'x' },
      { passwordHash: 'x' },
      { token: 'x' },
      { nested: { deep: { email: 'x' } } },
      { note: 'maria@example.com' },
      { doc: 'V-12345678' },
      { doc: 'J-123456789' },
    ]) {
      expect(() => assertAuditPayload(bad)).toThrow(/Invalid audit payload/);
    }
  });

  it('uses the shared ID pattern (Story 20.2): spaced/dotted forms are rejected, UUIDs, dates and hashes are not', () => {
    for (const bad of [
      'V 12345678',
      'v-12.345.678',
      'E1234567',
      'J-12345678-9',
    ]) {
      expect(() => assertAuditPayload({ note: bad })).toThrow(/ID document/);
    }
    for (const ok of [
      'e1234567-89ab-4cde-8f01-23456789abcd',
      '2026-11-03',
      'PENDING12345',
      'a'.repeat(64),
    ]) {
      expect(() => assertAuditPayload({ note: ok })).not.toThrow();
    }
  });

  it('a salted hash of an email is allowed under a *Hash key', () => {
    expect(() =>
      assertAuditPayload({ emailHash: 'f'.repeat(64) }),
    ).not.toThrow();
  });
});

describe('AUDIT_ACTIONS (FR-139)', () => {
  it('has the whole catalog, each with the story that emits it', () => {
    const expected = [
      'LOGIN_ADMIN_OK',
      'LOGIN_ADMIN_FAILED',
      'LOGIN_ADMIN_FAILED_SUMMARY',
      'CUSTOMER_PASSWORD_RESET',
      'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN',
      'REFUND_PENDING_RECORDED',
      'PRODUCT_CREATED',
      'PRODUCT_DELETED',
      'PRODUCT_ACTIVE_CHANGED',
      'DATA_IMPORT_RUN',
      'LOGOUT_ADMIN',
      'ADMIN_CREDENTIALS_CHANGED',
      'ADMIN_ROLE_CHANGED',
      'ADMIN_CREATED',
      'ADMIN_DISABLED',
      'CUSTOMER_ANONYMIZED',
      'ID_DOC_REVEALED',
      'USAGE_LOG_QUERIED',
      'AUDIT_EVENTS_QUERIED',
      'ID_DOC_INTEGRITY_FAILED',
      'PAYMENT_PAGO_MOVIL_CONFIRMED',
      'PAYMENT_PAGO_MOVIL_REJECTED',
      'STRIPE_PAYMENT_STATE_CHANGED',
      'REFUND_ISSUED',
      'ORDER_STATUS_CHANGED',
      'ORDER_TRACKING_CHANGED',
      'PRODUCT_PRICE_CHANGED',
      'PRODUCT_STOCK_ADJUSTED',
      'FX_SOURCE_CHANGED',
      'FX_RATE_CHANGED',
      'LEGAL_DOC_PUBLISHED',
      'SELLER_IDENTITY_UPDATED',
      'CONSENT_RECORDED',
      'VITRINA_CONFIG_CHANGED',
      'DATA_EXPORTED',
      'SHIPPING_AGENCY_CHANGED',
      'RETENTION_PURGE_RUN',
      'DATA_MIGRATION_RUN',
      'AUDIT_VERIFIED',
    ];
    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual([...expected].sort());
    for (const [name, v] of Object.entries(AUDIT_ACTIONS)) {
      expect(v.emittedBy).toMatch(/^20\.\d+$/);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(isAuditAction('AUDIT_VERIFIED')).toBe(true);
    expect(isAuditAction('toString')).toBe(false);
    expect(isAuditAction('nope')).toBe(false);
  });
});
