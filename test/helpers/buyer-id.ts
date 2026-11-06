/**
 * Story 20.4 (FR-127): the buyer fiscal ID for e2e checkout bodies. The storefront of Story 20.9
 * sends it; until then `CHECKOUT_REQUIRE_BUYER_ID` is off by default, but the previous checkout
 * suites send it too (through `withBuyerId`) so they exercise the same body the real storefront
 * will send and keep passing when the switch is on. Synthetic numbers only.
 */
export const E2E_BUYER = { type: 'V', number: '19876543' } as const;
/** Canonical form of `E2E_BUYER` (what the order stores, encrypted). */
export const E2E_BUYER_CANONICAL = 'V-19876543';

/** A J RIF with a valid check digit (hand-computed in the 20.2 spec) and its legal name. */
export const E2E_COMPANY = {
  buyerId: { type: 'J', number: '070133805' },
  buyerLegalName: 'Empresa Sintetica C.A.',
} as const;

const AGENCY_KEYS = [
  'customerAddressId',
  'shippingAgencyId',
  'deliveryMode',
  'agencyBranchName',
  'agencyBranchCode',
  'municipality',
  'parish',
  'referencePoint',
];

/** Same rule as the server: any agency/saved-address field means the Epic 17 format. */
export const isAgencyFormat = (body: Record<string, unknown>): boolean =>
  AGENCY_KEYS.some((k) => body[k] !== undefined && body[k] !== null);

/**
 * Adds the buyer ID to a checkout body unless it already carries one:
 * the agency / saved-address format buys "as the recipient", the legacy flat format sends an
 * explicit V number (it has no recipient cedula to copy).
 */
export function withBuyerId<T extends object>(
  body: T,
): T & Record<string, unknown> {
  const b = body as Record<string, unknown>;
  if ('buyerId' in b || 'buyerSameAsRecipient' in b)
    return body as T & Record<string, unknown>;
  return (isAgencyFormat(b)
    ? { ...b, buyerSameAsRecipient: true }
    : { ...b, buyerId: { ...E2E_BUYER } }) as unknown as T &
    Record<string, unknown>;
}
