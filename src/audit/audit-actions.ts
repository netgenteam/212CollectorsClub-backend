/**
 * Story 20.1 (AD-99, FR-139): catalog of audit actions. A TypeScript `const`,
 * NOT a Postgres enum: adding an action in a later epic needs no DDL (the table
 * only checks `action ~ '^[A-Z0-9_]+$'`). `emittedBy` is the story of Epic 20
 * that wires the emission.
 */
export const AUDIT_ACTIONS = {
  // Admin session
  LOGIN_ADMIN_OK: { emittedBy: '20.5' },
  LOGIN_ADMIN_FAILED: { emittedBy: '20.5' },
  LOGOUT_ADMIN: { emittedBy: '20.5' },
  // Admin accounts
  ADMIN_CREDENTIALS_CHANGED: { emittedBy: '20.5' },
  ADMIN_ROLE_CHANGED: { emittedBy: '20.5' },
  ADMIN_CREATED: { emittedBy: '20.5' },
  ADMIN_DISABLED: { emittedBy: '20.5' },
  // Privacy
  CUSTOMER_ANONYMIZED: { emittedBy: '20.6' },
  ID_DOC_REVEALED: { emittedBy: '20.4' },
  // Payments and orders
  PAYMENT_PAGO_MOVIL_CONFIRMED: { emittedBy: '20.5' },
  PAYMENT_PAGO_MOVIL_REJECTED: { emittedBy: '20.5' },
  STRIPE_PAYMENT_STATE_CHANGED: { emittedBy: '20.5' },
  REFUND_ISSUED: { emittedBy: '20.5' },
  ORDER_STATUS_CHANGED: { emittedBy: '20.5' },
  ORDER_TRACKING_CHANGED: { emittedBy: '20.5' },
  // Catalog
  PRODUCT_PRICE_CHANGED: { emittedBy: '20.5' },
  PRODUCT_STOCK_ADJUSTED: { emittedBy: '20.5' },
  // Epic 18
  FX_SOURCE_CHANGED: { emittedBy: '20.5' },
  FX_RATE_CHANGED: { emittedBy: '20.5' },
  VITRINA_CONFIG_CHANGED: { emittedBy: '20.5' },
  // Epic 19
  LEGAL_DOC_PUBLISHED: { emittedBy: '20.5' },
  SELLER_IDENTITY_UPDATED: { emittedBy: '20.5' },
  CONSENT_RECORDED: { emittedBy: '20.5' },
  // Operations
  DATA_EXPORTED: { emittedBy: '20.5' },
  SHIPPING_AGENCY_CHANGED: { emittedBy: '20.5' },
  RETENTION_PURGE_RUN: { emittedBy: '20.8' },
  DATA_MIGRATION_RUN: { emittedBy: '20.3' },
  AUDIT_VERIFIED: { emittedBy: '20.1' },
} as const satisfies Record<string, { emittedBy: `20.${number}` }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (v: unknown): v is AuditAction =>
  typeof v === 'string' &&
  Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, v);
