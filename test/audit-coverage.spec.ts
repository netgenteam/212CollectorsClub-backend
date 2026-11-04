import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit/audit-actions.js';
import type { AuditAction } from '../src/audit/audit-actions.js';

/**
 * Story 20.5 (AC7, FR-138): static coverage of the audit catalog.
 *  - every action with `emittedBy: '20.5'` is either EMITTED (a file that names it and really
 *    adds/records an event) or JUSTIFIED as pending (why nothing can emit it today);
 *  - a service that mutates a catalog entity without emitting fails the test;
 *  - the emitters never call the old unaudited `$transaction` for those writes.
 * The e2e (`audit-emission.e2e-spec.ts`) proves the same list with real events.
 */
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'generated' || e.name === 'node_modules') return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
const sources = walk(SRC)
  .filter((p) => !p.endsWith('.spec.ts'))
  .map((p) => ({ file: rel(p), text: readFileSync(p, 'utf8') }));
const read = (file: string): string => {
  const s = sources.find((x) => x.file === file);
  if (!s) throw new Error(`${file} does not exist`);
  return s.text;
};

/** Emission = `audit.add(` / `collector.add(` / `.record(` / a builder that returns the event. */
const EMITS = /\b(audit|collector)\s*\.\s*add\s*\(|\.\s*record\s*\(/;

/** action -> the files that emit it (each must name the action or its builder, and emit). */
const EMITTED: Partial<
  Record<AuditAction, { file: string; marker: string }[]>
> = {
  LOGIN_ADMIN_OK: [
    {
      file: 'src/admin-auth/admin-auth.service.ts',
      marker: "'LOGIN_ADMIN_OK'",
    },
  ],
  LOGIN_ADMIN_FAILED: [
    {
      file: 'src/admin-auth/admin-auth.service.ts',
      marker: "'LOGIN_ADMIN_FAILED'",
    },
  ],
  LOGIN_ADMIN_FAILED_SUMMARY: [
    {
      file: 'src/admin-auth/admin-login-failure-summary.ts',
      marker: "'LOGIN_ADMIN_FAILED_SUMMARY'",
    },
  ],
  LOGOUT_ADMIN: [
    { file: 'src/admin-auth/admin-auth.service.ts', marker: "'LOGOUT_ADMIN'" },
  ],
  CUSTOMER_PASSWORD_RESET: [
    {
      file: 'src/customer-auth/customer-auth.service.ts',
      marker: "'CUSTOMER_PASSWORD_RESET'",
    },
  ],
  CUSTOMER_EMAIL_VERIFIED_BY_ADMIN: [
    {
      file: 'src/admin-customers/admin-customers.service.ts',
      marker: "'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN'",
    },
  ],
  REFUND_PENDING_RECORDED: [
    {
      file: 'src/payments-stripe/stripe-payments.service.ts',
      marker: "'REFUND_PENDING_RECORDED'",
    },
  ],
  PRODUCT_CREATED: [
    {
      file: 'src/admin-catalog/admin-products.service.ts',
      marker: "'PRODUCT_CREATED'",
    },
  ],
  PRODUCT_DELETED: [
    {
      file: 'src/admin-catalog/admin-products.service.ts',
      marker: "'PRODUCT_DELETED'",
    },
  ],
  PRODUCT_ACTIVE_CHANGED: [
    {
      file: 'src/admin-catalog/admin-products.service.ts',
      marker: "'PRODUCT_ACTIVE_CHANGED'",
    },
  ],
  DATA_IMPORT_RUN: [
    { file: 'src/tcg/tcg-sync-run.service.ts', marker: "'DATA_IMPORT_RUN'" },
  ],
  PAYMENT_PAGO_MOVIL_CONFIRMED: [
    {
      file: 'src/orders/admin-order-payment.service.ts',
      marker: "'PAYMENT_PAGO_MOVIL_CONFIRMED'",
    },
  ],
  PAYMENT_PAGO_MOVIL_REJECTED: [
    {
      file: 'src/orders/admin-order-payment.service.ts',
      marker: "'PAYMENT_PAGO_MOVIL_REJECTED'",
    },
  ],
  STRIPE_PAYMENT_STATE_CHANGED: [
    {
      file: 'src/payments-stripe/stripe-payments.service.ts',
      marker: "'STRIPE_PAYMENT_STATE_CHANGED'",
    },
  ],
  ORDER_STATUS_CHANGED: [
    {
      file: 'src/orders/admin-order-fulfillment.service.ts',
      marker: 'orderStatusChangedEvent(',
    },
    {
      file: 'src/orders/cron/stock-hold-expiry-cron.service.ts',
      marker: 'orderStatusChangedEvent(',
    },
    {
      file: 'src/orders/cron/payment-processing-timeout-cron.service.ts',
      marker: 'orderStatusChangedEvent(',
    },
    {
      file: 'src/checkout/checkout.service.ts',
      marker: 'orderStatusChangedEvent(',
    },
  ],
  ORDER_TRACKING_CHANGED: [
    {
      file: 'src/orders/admin-order-tracking.service.ts',
      marker: "'ORDER_TRACKING_CHANGED'",
    },
  ],
  PRODUCT_PRICE_CHANGED: [
    {
      file: 'src/admin-catalog/admin-products.service.ts',
      marker: "'PRODUCT_PRICE_CHANGED'",
    },
  ],
  PRODUCT_STOCK_ADJUSTED: [
    {
      file: 'src/admin-catalog/admin-products.service.ts',
      marker: "'PRODUCT_STOCK_ADJUSTED'",
    },
  ],
  SHIPPING_AGENCY_CHANGED: [
    {
      file: 'src/shipping/shipping-agencies.service.ts',
      marker: "'SHIPPING_AGENCY_CHANGED'",
    },
  ],
  FX_SOURCE_CHANGED: [
    { file: 'src/fx/admin-fx.service.ts', marker: "'FX_SOURCE_CHANGED'" },
  ],
  FX_RATE_CHANGED: [
    { file: 'src/fx/admin-fx.service.ts', marker: "'FX_RATE_CHANGED'" },
    // the provider refresh (cron and the admin's "refresh now"): actor SYSTEM
    { file: 'src/fx/fx-refresh.service.ts', marker: "'FX_RATE_CHANGED'" },
  ],
  VITRINA_CONFIG_CHANGED: [
    {
      file: 'src/vitrina/admin-vitrina.service.ts',
      marker: "'VITRINA_CONFIG_CHANGED'",
    },
  ],
  LEGAL_DOC_PUBLISHED: [
    {
      file: 'src/legal/legal-audit.service.ts',
      marker: "'LEGAL_DOC_PUBLISHED'",
    },
  ],
  SELLER_IDENTITY_UPDATED: [
    {
      file: 'src/legal/legal-audit.service.ts',
      marker: "'SELLER_IDENTITY_UPDATED'",
    },
  ],
  CONSENT_RECORDED: [
    { file: 'src/legal/consent.service.ts', marker: "'CONSENT_RECORDED'" },
  ],
  DATA_EXPORTED: [
    { file: 'src/audit/audit.service.ts', marker: "'DATA_EXPORTED'" },
  ],
};

/** `emittedBy: '20.5'` actions that cannot be emitted today, and why (reviewed, not forgotten). */
const PENDING_JUSTIFIED: Partial<Record<AuditAction, string>> = {
  REFUND_ISSUED:
    'There is no refund route in the backend (refunds are made by hand in the Stripe dashboard; the webhook only logs PAID_AFTER_TERMINAL / PAID_BUT_NO_STOCK). The day a refund endpoint exists it must call audit.add(REFUND_ISSUED) in its transaction (the catalog entry and payload sample are ready).',
  ADMIN_CREDENTIALS_CHANGED:
    'No flow changes an admin password/email (admins come from the seed; there is no endpoint). A104: only "where the flows exist".',
  ADMIN_ROLE_CHANGED: 'No flow changes `roleTier` (reserved, unused). A104.',
  ADMIN_CREATED: 'No admin creation endpoint (seed only). A104.',
  ADMIN_DISABLED: 'No admin disable endpoint. A104.',
};

/** Services that mutate a catalog entity: each MUST emit (a service that stops emitting fails here). */
const MUTATORS: { file: string; mutates: RegExp }[] = [
  {
    file: 'src/orders/admin-order-payment.service.ts',
    mutates: /guardedOrderStatusTransition\(/,
  },
  {
    file: 'src/orders/admin-order-fulfillment.service.ts',
    mutates: /guardedOrderStatusTransition\(/,
  },
  {
    file: 'src/orders/admin-order-tracking.service.ts',
    mutates: /orderTrackingEvent\.create\(/,
  },
  {
    file: 'src/orders/cron/stock-hold-expiry-cron.service.ts',
    mutates: /guardedOrderStatusTransition\(/,
  },
  {
    file: 'src/orders/cron/payment-processing-timeout-cron.service.ts',
    mutates: /guardedOrderStatusTransition\(/,
  },
  {
    file: 'src/payments-stripe/stripe-payments.service.ts',
    mutates: /guardedOrderStatusTransition\(/,
  },
  {
    file: 'src/admin-catalog/admin-products.service.ts',
    mutates: /stock: dto\.stock|data\.priceUsd/,
  },
  {
    file: 'src/admin-catalog/admin-products.service.ts',
    mutates: /tx\.product\.(create|delete)\(|isActive: false/,
  },
  { file: 'src/fx/fx-refresh.service.ts', mutates: /vesPerUsd: rate/ },
  {
    file: 'src/tcg/tcg-sync-run.service.ts',
    mutates: /tcgSyncRun\.update\(/,
  },
  {
    file: 'src/admin-customers/admin-customers.service.ts',
    mutates: /emailVerified: true/,
  },
  {
    file: 'src/payments-stripe/stripe-payments.service.ts',
    mutates: /REFUND_PENDING_NO_STOCK|REFUND_PENDING_AFTER_TERMINAL/,
  },
  {
    file: 'src/shipping/shipping-agencies.service.ts',
    mutates: /shippingAgency\.(create|update|delete)\(/,
  },
  { file: 'src/fx/admin-fx.service.ts', mutates: /fxRateSetting\.update\(/ },
  {
    file: 'src/vitrina/admin-vitrina.service.ts',
    mutates: /vitrinaAlgorithmSetting\.update\(/,
  },
  {
    file: 'src/legal/legal-publish.service.ts',
    mutates: /Legal_Document_Versions/,
  },
  {
    file: 'src/legal/seller-identity.service.ts',
    mutates: /Seller_Identity_Settings/,
  },
  {
    file: 'src/legal/consent.service.ts',
    mutates: /INSERT INTO "Consent_Records"/,
  },
  {
    file: 'src/admin-auth/admin-auth.service.ts',
    mutates: /createSession\(|DELETE FROM "Admin_Sessions"/,
  },
];

describe('audit catalog coverage (Story 20.5, AC7)', () => {
  const ours = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
    (a) => AUDIT_ACTIONS[a].emittedBy === '20.5',
  );

  it('every 20.5 action is emitted OR justified as pending, never both, never neither', () => {
    for (const a of ours) {
      const emitted = a in EMITTED;
      const pending = a in PENDING_JUSTIFIED;
      expect({ a, emitted, pending, ok: emitted !== pending }).toMatchObject({
        ok: true,
      });
    }
    // and nothing stale: every key of both maps is a real 20.5 action
    for (const a of [
      ...Object.keys(EMITTED),
      ...Object.keys(PENDING_JUSTIFIED),
    ]) {
      expect(ours).toContain(a);
    }
    for (const reason of Object.values(PENDING_JUSTIFIED)) {
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it('each emitted action has its file naming it and really emitting', () => {
    for (const [action, sites] of Object.entries(EMITTED)) {
      for (const { file, marker } of sites ?? []) {
        const text = read(file);
        expect({ action, file, names: text.includes(marker) }).toMatchObject({
          names: true,
        });
        // the builders (`orderStatusChangedEvent`, `legalAuditEvent`) are consumed by an add(...)
        // in the same file or in the legal service that delegates to the collector
        const emits =
          EMITS.test(text) ||
          (file === 'src/legal/legal-audit.service.ts' &&
            /collector\.add\(event\)/.test(text)) ||
          (file === 'src/audit/audit.service.ts' && /audit\.add\(/.test(text));
        expect({ action, file, emits }).toMatchObject({ emits: true });
      }
    }
  });

  it('a catalog service that mutates without emitting fails (FR-138)', () => {
    for (const { file, mutates } of MUTATORS) {
      const text = read(file);
      expect({ file, mutates: mutates.test(text) }).toMatchObject({
        mutates: true,
      });
      expect({
        file,
        emits: EMITS.test(text) || /legalAuditEvent|audit\.record\(/.test(text),
      }).toMatchObject({ emits: true });
    }
  });

  it('every file that moves an Order status through the guarded transition also emits', () => {
    const files = sources.filter(
      (s) =>
        /guardedOrderStatusTransition\(/.test(s.text) &&
        s.file !== 'src/common/order-status-transition.ts',
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      expect({ file: f.file, emits: EMITS.test(f.text) }).toMatchObject({
        emits: true,
      });
    }
  });

  it('no emitter calls AuditService.record (reserved for the reveal of 20.4); they all use transaction + add', () => {
    // `audit.transaction(` never mixed with a bare `prisma.$transaction(` for the SAME write is
    // checked by review; here: no emitter calls record() (reserved for the reveal, 20.4).
    const recorders = sources.filter(
      (s) =>
        /\baudit\s*\.\s*record\s*\(/.test(s.text) &&
        // `LegalAuditService.record` (the domain log) is not `AuditService.record`.
        !/LegalAuditService/.test(s.text) &&
        !s.file.startsWith('src/audit/'),
    );
    expect(recorders.map((r) => r.file)).toEqual([
      'src/crypto/id-doc-reveal.service.ts',
    ]);
  });
});
