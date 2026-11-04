import type { PublicFields } from './audit-payload.js';

/**
 * Public data the SELLER publishes about itself (legal identity, fiscal address,
 * contact, Pago Movil account). It is not personal data of a customer, so the
 * payload guard lets exactly these keys through `SELLER_IDENTITY_UPDATED` (and
 * only there), exempting each one from the value detector it would otherwise
 * trip (a RIF looks like a cedula, a contact email is an email...).
 */
const SELLER_PUBLIC = {
  legalName: [],
  rif: ['CEDULA'],
  sellerRif: ['CEDULA'],
  fiscalAddress: [],
  legalAddress: [],
  address: [],
  contactEmail: ['EMAIL'],
  sellerEmail: ['EMAIL'],
  phone: ['PHONE'],
  sellerPhone: ['PHONE'],
  phoneCountry: [],
  pagoMovilPhone: ['PHONE'],
  pagoMovilBank: [],
  pagoMovilRif: ['CEDULA'],
} as const satisfies PublicFields;

/** `pagoMovilBank` is a bank name; only the word "movil" trips the key guard. */
const PAGO_MOVIL_PUBLIC = {
  pagoMovilBank: [],
} as const satisfies PublicFields;

/**
 * WHAT COUNTS AS A RISK ACTION (the written criterion for adding an action to this catalog;
 * `docs/deployment.md` 17.6 repeats it). An admin/system action is audited when it does AT LEAST ONE of:
 *   R1. moves money or a payment state, or records that money must be returned (payments,
 *       refund-pending webhook rows);
 *   R2. changes what the shopper pays or can buy: a price, stock, the existence or visibility of
 *       a product (create, delete, `isActive`), shipping options, the FX rate or its source,
 *       the vitrina ranking, a batch import that rewrites prices;
 *   R3. grants, revokes or proves access or identity: admin sessions, a customer password reset,
 *       an admin vouching for an email (`verify-email`);
 *   R4. discloses or destroys personal data (cedula reveal, anonymization, retention purge);
 *   R5. changes legal text, the seller identity or the consent evidence.
 * NOT audited here (reviewed on purpose): landing blocks and their images, the pack simulator
 * configuration and category taxonomy (presentation or navigation content with its own
 * draft/publish or reversible edits, no money, no personal data, no change to what can be
 * bought), product image uploads and tag edits, cart/wishlist, and the customer's own profile and
 * change-password (needs the current password). The 7-day admin usage log of Story 20.7 covers
 * everything else. A new action that meets one of R1-R5 must be added here with an emitter and a
 * payload sample (`audit-catalog-payloads.spec.ts`), or the coverage test fails.
 *
 * Story 20.1 (AD-99, FR-139): catalog of audit actions. A TypeScript `const`,
 * NOT a Postgres enum: adding an action in a later epic needs no DDL (the table
 * only checks `action ~ '^[A-Z0-9_]+$'`). `emittedBy` is the story of Epic 20
 * that wires the emission. `publicFields` (optional) is the explicit, per-action
 * allowance of public business data the payload guard would otherwise reject
 * (see `PublicFields` in `audit-payload.ts`; keys are first-level names or full
 * paths). No action has it by default, and only the actions in the allow-list of
 * `audit-catalog-payloads.spec.ts` may declare one.
 */
export const AUDIT_ACTIONS = {
  // Admin session
  LOGIN_ADMIN_OK: { emittedBy: '20.5' },
  LOGIN_ADMIN_FAILED: { emittedBy: '20.5' },
  // One event per minute at most: how many failed logins the per-minute budget could not write
  // (count, window, hashed identifiers). Keeps the attack visible in the chain without a row per try.
  LOGIN_ADMIN_FAILED_SUMMARY: { emittedBy: '20.5' },
  LOGOUT_ADMIN: { emittedBy: '20.5' },
  // Admin accounts
  ADMIN_CREDENTIALS_CHANGED: { emittedBy: '20.5' },
  ADMIN_ROLE_CHANGED: { emittedBy: '20.5' },
  ADMIN_CREATED: { emittedBy: '20.5' },
  ADMIN_DISABLED: { emittedBy: '20.5' },
  // Customer accounts (R3)
  CUSTOMER_PASSWORD_RESET: { emittedBy: '20.5' },
  CUSTOMER_EMAIL_VERIFIED_BY_ADMIN: { emittedBy: '20.5' },
  // Privacy
  CUSTOMER_ANONYMIZED: { emittedBy: '20.6' },
  ID_DOC_REVEALED: { emittedBy: '20.4' },
  // A reveal whose stored value failed the integrity check (moved ciphertext, tampering, bad key).
  ID_DOC_INTEGRITY_FAILED: { emittedBy: '20.4' },
  // Payments and orders
  PAYMENT_PAGO_MOVIL_CONFIRMED: {
    emittedBy: '20.5',
    publicFields: PAGO_MOVIL_PUBLIC,
  },
  PAYMENT_PAGO_MOVIL_REJECTED: {
    emittedBy: '20.5',
    publicFields: PAGO_MOVIL_PUBLIC,
  },
  STRIPE_PAYMENT_STATE_CHANGED: { emittedBy: '20.5' },
  REFUND_ISSUED: { emittedBy: '20.5' },
  // A Stripe webhook that charged the buyer for an order that could not be paid (no stock / already
  // failed): a refund must be made by hand in the Stripe dashboard.
  REFUND_PENDING_RECORDED: { emittedBy: '20.5' },
  ORDER_STATUS_CHANGED: { emittedBy: '20.5' },
  ORDER_TRACKING_CHANGED: { emittedBy: '20.5' },
  // Catalog
  PRODUCT_PRICE_CHANGED: { emittedBy: '20.5' },
  PRODUCT_STOCK_ADJUSTED: { emittedBy: '20.5' },
  PRODUCT_CREATED: { emittedBy: '20.5' },
  PRODUCT_DELETED: { emittedBy: '20.5' },
  PRODUCT_ACTIVE_CHANGED: { emittedBy: '20.5' },
  // ONE summary event per TCG ingest / nightly price sync run (counters), never a row per price.
  DATA_IMPORT_RUN: { emittedBy: '20.5' },
  // Epic 18
  FX_SOURCE_CHANGED: { emittedBy: '20.5' },
  FX_RATE_CHANGED: { emittedBy: '20.5' },
  VITRINA_CONFIG_CHANGED: { emittedBy: '20.5' },
  // Epic 19
  LEGAL_DOC_PUBLISHED: { emittedBy: '20.5' },
  SELLER_IDENTITY_UPDATED: {
    emittedBy: '20.5',
    publicFields: SELLER_PUBLIC,
  },
  CONSENT_RECORDED: { emittedBy: '20.5' },
  // Operations
  DATA_EXPORTED: { emittedBy: '20.5' },
  // A carrier branch address is a public office, not a person's. `address` at the first
  // level (one branch) and `branches[].address` (a list of branches): any OTHER nesting
  // is not exempt (the allowance is by full path, see `PublicFields`).
  SHIPPING_AGENCY_CHANGED: {
    emittedBy: '20.5',
    publicFields: { address: [], 'branches[].address': [] },
  },
  RETENTION_PURGE_RUN: { emittedBy: '20.8' },
  DATA_MIGRATION_RUN: { emittedBy: '20.3' },
  AUDIT_VERIFIED: { emittedBy: '20.1' },
} as const satisfies Record<
  string,
  { emittedBy: `20.${number}`; publicFields?: PublicFields }
>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (v: unknown): v is AuditAction =>
  typeof v === 'string' &&
  Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, v);

/** The public-field allowance of an action (undefined: none). */
export const publicFieldsOf = (action: AuditAction): PublicFields | undefined =>
  (AUDIT_ACTIONS[action] as { publicFields?: PublicFields }).publicFields;
