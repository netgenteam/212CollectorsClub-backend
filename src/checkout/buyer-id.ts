import { HttpStatus, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { splitIdDocFromName } from '../crypto/id-doc-in-name.js';
import { normalizeIdDoc } from '../crypto/id-doc-normalize.js';
import {
  isRifCheckDigitStrict,
  isValidRif,
} from '../crypto/rif-check-digit.js';
import { canonicalRecipientIdDoc } from '../shipping/shipping-validators.js';

/**
 * Story 20.4 (FR-127, AD-97): fiscal ID of the BUYER (the one that goes on the invoice).
 * Everything here is pure: no I/O, no DB, no crypto, so it runs BEFORE the checkout
 * transaction opens and a rejection can never leave an Order or a StockHold behind.
 *
 * Rules (A89, A98):
 *   V / E : 6-9 digits.
 *   J / G : RIF of 9 digits (8 + check digit). The check digit is verified unless
 *           `RIF_CHECKDIGIT_STRICT=false` (`rif-check-digit.ts`). `buyerLegalName` is required.
 *   P     : alphanumeric, 6-12 characters, at least one digit.
 * `buyerSameAsRecipient: true` copies the recipient's cedula (A87) and only holds when the
 * recipient is V/E and exists (agency or saved-address format). In the legacy flat format
 * there is no recipient cedula to copy: BUYER_ID_REQUIRED.
 *
 * Errors carry `details.field` and `details.reason` only (never the value, NFR-20.5) so the
 * storefront can show a concrete message.
 */
export const BUYER_ID_TYPES = ['V', 'E', 'J', 'P', 'G'] as const;
export type BuyerIdTypeValue = (typeof BUYER_ID_TYPES)[number];

export const BUYER_ID_REQUIRED = 'BUYER_ID_REQUIRED';
export const BUYER_ID_INVALID = 'BUYER_ID_INVALID';
export const BUYER_LEGAL_NAME_MAX = 200;

/** The three shapes of the shipping part of a checkout body (Story 17.4). */
export type CheckoutShippingFormat = 'saved' | 'agency' | 'flat';

export interface BuyerIdInput {
  buyerId?: { type?: unknown; number?: unknown } | null;
  buyerSameAsRecipient?: boolean | null;
  buyerLegalName?: unknown;
}

export interface BuyerShippingContext {
  /** `saved`: a saved address (its cedula lives in the DB, checked inside the transaction). */
  format: CheckoutShippingFormat;
  /** Recipient cedula as sent in the body (agency/flat formats); null when absent. */
  recipientIdDoc: string | null;
}

export type ResolvedBuyerId =
  /** Not required (`CHECKOUT_REQUIRE_BUYER_ID` is not `true`) and not sent: the order keeps no buyer ID. */
  | { kind: 'none' }
  | {
      kind: 'explicit';
      type: BuyerIdTypeValue;
      digits: string;
      canonical: string;
      legalName: string | null;
    }
  | {
      kind: 'same-as-recipient';
      /** Known now when the agency-format body carries a valid V/E cedula; otherwise null (a saved address, read inside the transaction, or an invalid one that the shipping validation rejects). */
      fromBody: { type: 'V' | 'E'; canonical: string } | null;
    };

const switchLogger = new Logger('BuyerIdSwitch');
const warnedValues = new Set<string>();

/** Test hook: forget which unrecognized values were already warned about. */
export function resetBuyerIdSwitchWarnings(): void {
  warnedValues.clear();
}

/**
 * Read on every call (never cached): only the exact string `true` makes the buyer ID mandatory.
 * That is deliberate (the interim switch defaults OFF so the legacy storefront keeps selling),
 * but a typo must not turn it off in silence: anything that is neither unset, `true` nor `false`
 * (`TRUE`, `1`, `yes`, ` true`, empty) leaves it OFF and logs a WARN, in EVERY environment. The
 * WARN is once per distinct value (the switch is read per request) and names the value (it is a
 * deployment flag, not personal data), so changing the value warns again.
 */
export function isBuyerIdRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.CHECKOUT_REQUIRE_BUYER_ID;
  if (raw === 'true') return true;
  if (raw !== undefined && raw !== 'false' && !warnedValues.has(raw)) {
    warnedValues.add(raw);
    switchLogger.warn(
      `CHECKOUT_REQUIRE_BUYER_ID=${JSON.stringify(raw.slice(0, 40))} is not recognized: only the exact string "true" turns the buyer ID requirement ON (and "false" or unset keep it OFF). It stays OFF. Fix the value (docs/deployment.md 16.2).`,
    );
  }
  return false;
}

export const buyerIdRequired = (field: string, reason: string): ApiException =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    BUYER_ID_REQUIRED,
    'The buyer fiscal ID (cedula / RIF / passport) is required.',
    { field, reason },
  );

export const buyerIdInvalid = (field: string, reason: string): ApiException =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    BUYER_ID_INVALID,
    'The buyer fiscal ID is not valid.',
    { field, reason },
  );

const isType = (v: unknown): v is BuyerIdTypeValue =>
  typeof v === 'string' && (BUYER_ID_TYPES as readonly string[]).includes(v);

const DIGITS = {
  V: /^\d{6,9}$/,
  E: /^\d{6,9}$/,
  J: /^\d{9}$/,
  G: /^\d{9}$/,
} as const;
/** Passport: 6-12 alphanumerics (the normalizer already guarantees at least one digit). */
const PASSPORT = /^[A-Z0-9]{6,12}$/;

/**
 * Validates a buyer ID. Returns the canonical value (`T-NNN...`). Throws 400
 * BUYER_ID_REQUIRED / BUYER_ID_INVALID.
 */
export function validateBuyerId(
  input: { type?: unknown; number?: unknown },
  opts: { strictRif?: boolean } = {},
): { type: BuyerIdTypeValue; digits: string; canonical: string } {
  if (input.type === undefined || input.type === null || input.type === '') {
    throw buyerIdRequired('buyerId.type', 'REQUIRED');
  }
  if (!isType(input.type)) throw buyerIdInvalid('buyerId.type', 'INVALID_TYPE');
  const type = input.type;
  if (input.number === undefined || input.number === null) {
    throw buyerIdRequired('buyerId.number', 'REQUIRED');
  }
  if (typeof input.number !== 'string') {
    throw buyerIdInvalid('buyerId.number', 'INVALID_FORMAT');
  }
  const raw = input.number.trim();
  if (raw === '') throw buyerIdRequired('buyerId.number', 'REQUIRED');
  if (raw.length > 30 || raw.includes('*')) {
    throw buyerIdInvalid('buyerId.number', 'INVALID_FORMAT');
  }
  const n = normalizeIdDoc(`${type}${raw}`);
  if (!n || n.unparsed || n.type !== type) {
    // Right characters, wrong amount of them => LENGTH (a concrete message); anything else => FORMAT
    // (a letter among the digits, a type letter inside the number, a mask).
    const compact = raw.toUpperCase().replace(/[\s.-]/g, '');
    const onlyRightChars =
      type === 'P'
        ? /^[A-Z0-9]+$/.test(compact) && /\d/.test(compact)
        : /^\d+$/.test(compact);
    throw buyerIdInvalid(
      'buyerId.number',
      onlyRightChars ? 'INVALID_LENGTH' : 'INVALID_FORMAT',
    );
  }
  if (type === 'P') {
    if (!PASSPORT.test(n.digits)) {
      throw buyerIdInvalid('buyerId.number', 'INVALID_LENGTH');
    }
  } else {
    if (!/^\d+$/.test(n.digits)) {
      throw buyerIdInvalid('buyerId.number', 'INVALID_FORMAT');
    }
    if (!DIGITS[type].test(n.digits)) {
      throw buyerIdInvalid('buyerId.number', 'INVALID_LENGTH');
    }
    if (
      (type === 'J' || type === 'G') &&
      !isValidRif(type, n.digits, { strict: opts.strictRif })
    ) {
      throw buyerIdInvalid('buyerId.number', 'INVALID_CHECK_DIGIT');
    }
  }
  return { type, digits: n.digits, canonical: n.canonical };
}

function legalNameOf(raw: unknown, required: boolean): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw buyerIdInvalid('buyerLegalName', 'INVALID_FORMAT');
  }
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean === '') {
    if (required) throw buyerIdRequired('buyerLegalName', 'REQUIRED');
    return null;
  }
  if (clean.length > BUYER_LEGAL_NAME_MAX) {
    throw buyerIdInvalid('buyerLegalName', 'TOO_LONG');
  }
  // A cedula or RIF inside the legal name would sit in clear in the database and in every view
  // (the very thing FR-123/FR-125 forbid). REJECTED, not cleaned: the legal name is what goes on
  // the invoice, so silently cutting `Emp V-87654321 C.A.` into `Emp C.A.` would invoice a
  // different name than the buyer typed, and the buyer's own RIF belongs in `buyerId`. The
  // detector is `splitIdDocFromName`, which only fires on an UNAMBIGUOUS token (type letter plus
  // the digit count that type really has, or a `CI`/`cedula` label), so a legitimate name such as
  // `Inversiones G-20000 C.A.` or `Edificio P-12345` passes.
  if (splitIdDocFromName(clean).found) {
    throw buyerIdInvalid('buyerLegalName', 'CONTAINS_ID_DOC');
  }
  return clean;
}

/**
 * Story 20.4 (AC1-AC2): decides what the order stores as buyer ID, before the transaction.
 *
 * - An explicit `buyerId` wins. Sending also `buyerSameAsRecipient: true` is a contradiction
 *   (BUYER_ID_INVALID), never a silent choice.
 * - `buyerSameAsRecipient: true` needs an agency/saved-address checkout whose recipient has a
 *   V/E cedula; for a saved address that is checked inside the transaction (the cedula is
 *   ciphertext in the DB), see `CheckoutService`.
 * - Nothing sent: 400 BUYER_ID_REQUIRED when `required`, else `{ kind: 'none' }`.
 */
export function resolveBuyerId(
  dto: BuyerIdInput,
  shipping: BuyerShippingContext,
  opts: { required?: boolean; strictRif?: boolean } = {},
): ResolvedBuyerId {
  const required = opts.required ?? isBuyerIdRequired();
  const sameAs = dto.buyerSameAsRecipient === true;
  const hasExplicit = dto.buyerId !== undefined && dto.buyerId !== null;

  if (hasExplicit) {
    if (sameAs) {
      throw buyerIdInvalid('buyerSameAsRecipient', 'CONFLICTS_WITH_BUYER_ID');
    }
    const strictRif = opts.strictRif ?? isRifCheckDigitStrict();
    const id = validateBuyerId(dto.buyerId as object, { strictRif });
    const legal = id.type === 'J' || id.type === 'G';
    return {
      kind: 'explicit',
      ...id,
      legalName: legal ? legalNameOf(dto.buyerLegalName, true) : null,
    };
  }

  if (sameAs) {
    if (shipping.format === 'flat') {
      // The legacy flat format has no recipient cedula to copy (Epic 17 route only).
      throw buyerIdRequired(
        'buyerSameAsRecipient',
        'SAME_AS_RECIPIENT_NEEDS_AGENCY_FORMAT',
      );
    }
    if (shipping.format === 'saved') {
      return { kind: 'same-as-recipient', fromBody: null };
    }
    // Agency format: the recipient cedula comes in this body. A missing or non V/E one is the
    // shipping validation's error (400 SHIPPING_INVALID, field recipientIdDoc), reported by the
    // checkout right after: it is the actionable one, so it is not pre-empted here.
    const raw = shipping.recipientIdDoc?.trim() ?? '';
    const canonical = raw === '' ? null : canonicalRecipientIdDoc(raw);
    if (canonical === null)
      return { kind: 'same-as-recipient', fromBody: null };
    return {
      kind: 'same-as-recipient',
      fromBody: { type: canonical[0] as 'V' | 'E', canonical },
    };
  }

  if (required) throw buyerIdRequired('buyerId', 'REQUIRED');
  return { kind: 'none' };
}
