import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { DeliveryMode } from '../generated/prisma/enums.js';
import type { ShippingValidationService } from '../shipping/shipping-validation.service.js';
import type { PreparedIdDoc } from '../crypto/id-doc-crypto.service.js';
import {
  canonicalRecipientIdDoc,
  validateShippingInput,
  type DeliveryModeWire,
  type ShippingFieldError,
  type ShippingValue,
} from '../shipping/shipping-validators.js';

/** Story 17.4 (AD-74): shipping fields of the checkout body that matter here. */
export interface CheckoutShippingInput {
  fulfillmentType?: string;
  customerAddressId?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientIdDoc?: string;
  deliveryMode?: string;
  shippingAgencyId?: string;
  agencyBranchName?: string;
  agencyBranchCode?: string;
  addressLine1?: string;
  addressLine2?: string;
  state?: string;
  municipality?: string;
  parish?: string;
  referencePoint?: string;
}

/** What the checkout needs from `IdDocCryptoService` (a seam for unit tests). */
export interface IdDocProtector {
  protect(raw: unknown): PreparedIdDoc | null;
}

/**
 * Story 20.3 (AD-96/97): the cedula is normalized and ENCRYPTED in the service BEFORE the
 * transaction opens (no CPU work and no way to throw inside it); the snapshot builder only
 * receives `{enc, blind}`. `prepared` is `null` when there is nothing to encrypt (saved address,
 * legacy flat format) or the value is not valid (the builder then reports SHIPPING_INVALID).
 */
export interface CheckoutIdDoc {
  crypto: IdDocProtector;
  prepared: PreparedIdDoc | null;
}

/** Values copied onto `Order` (never a FK to the address: AD-74). The plain `recipientIdDoc` is never written (stays NULL). */
export interface OrderShippingData {
  recipientName: string;
  recipientPhone: string;
  recipientIdDocEnc: string | null;
  recipientIdDocBlind: string | null;
  deliveryMode: DeliveryMode | null;
  shippingAgencyId: string | null;
  agencyBranchName: string | null;
  agencyBranchCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  municipality: string | null;
  parish: string | null;
  referencePoint: string | null;
  country: string;
}

const NEW_FORMAT_KEYS = [
  'customerAddressId',
  'recipientIdDoc',
  'deliveryMode',
  'shippingAgencyId',
  'agencyBranchName',
  'agencyBranchCode',
  'municipality',
  'parish',
  'referencePoint',
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB varchar limits of fields whose DTO validation is skipped in the new format. */
const MAX_LEN: Record<string, number> = { state: 100, addressLine1: 200 };

export function isNewShippingFormat(o: CheckoutShippingInput): boolean {
  return NEW_FORMAT_KEYS.some((k) => o[k] !== undefined && o[k] !== null);
}

/** Read on every call (never cached): only the exact string `true` enables it. */
export function isShippingRequired(): boolean {
  return process.env.CHECKOUT_REQUIRE_SHIPPING === 'true';
}

export function addressNotFoundException(): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'ADDRESS_NOT_FOUND',
    'Address not found.',
  );
}

function agencyUnavailableException(): ApiException {
  return new ApiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SHIPPING_AGENCY_UNAVAILABLE',
    'The shipping agency does not exist or is not available.',
  );
}

/** Checks that need no DB; run before touching cart or stock. */
export function assertCheckoutShippingPreconditions(
  dto: CheckoutShippingInput,
  hasCustomer: boolean,
): void {
  if (dto.fulfillmentType === 'pickup') {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'PICKUP_NOT_SUPPORTED',
      'Store pickup is no longer supported; use delivery.',
    );
  }
  if (dto.customerAddressId !== undefined && !hasCustomer) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'ADDRESS_REQUIRES_ACCOUNT',
      'A saved address can only be used when logged in.',
    );
  }
  if (!isNewShippingFormat(dto) && isShippingRequired()) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'SHIPPING_REQUIRED',
      'Shipping data (agency, delivery mode and recipient ID) is required.',
    );
  }
}

/**
 * Pure and synchronous, no I/O: call it BEFORE `$transaction`. Mirrors the validation of the body
 * path (`canonicalRecipientIdDoc`); an invalid value yields `null` and the builder rejects it.
 */
export function prepareCheckoutIdDoc(
  dto: CheckoutShippingInput,
  crypto: IdDocProtector,
): PreparedIdDoc | null {
  if (!isNewShippingFormat(dto) || dto.customerAddressId !== undefined) {
    return null;
  }
  if (typeof dto.recipientIdDoc !== 'string') return null;
  const canonical = canonicalRecipientIdDoc(dto.recipientIdDoc.trim());
  return canonical === null ? null : crypto.protect(canonical);
}

function fromValue(
  v: ShippingValue,
  agencyId: string,
  idDoc: CheckoutIdDoc,
): OrderShippingData {
  const same =
    idDoc.prepared !== null && idDoc.prepared.canonical === v.recipientIdDoc;
  const p = same ? idDoc.prepared : idDoc.crypto.protect(v.recipientIdDoc);
  return {
    recipientName: v.recipientName,
    recipientPhone: v.recipientPhone,
    recipientIdDocEnc: p?.enc ?? null,
    recipientIdDocBlind: p?.blind ?? null,
    deliveryMode:
      v.deliveryMode === 'home_delivery' ? 'HOME_DELIVERY' : 'AGENCY_OFFICE',
    shippingAgencyId: agencyId,
    agencyBranchName: v.agencyBranchName,
    agencyBranchCode: v.agencyBranchCode,
    addressLine1: v.addressLine1,
    addressLine2: v.addressLine2,
    city: v.municipality, // A50
    state: v.state,
    municipality: v.municipality,
    parish: v.parish,
    referencePoint: v.referencePoint,
    country: 'Venezuela',
  };
}

/**
 * Resolves the order's shipping data. Legacy flat format: unchanged fields.
 * New format: saved address (read inside `tx`, prevails over body fields) or
 * validated body, both followed by the active-agency check (A52).
 */
export async function resolveCheckoutShipping(
  tx: Prisma.TransactionClient,
  shipping: ShippingValidationService,
  dto: CheckoutShippingInput & { city?: string },
  customerId: string | null,
  idDoc: CheckoutIdDoc,
): Promise<OrderShippingData> {
  if (!isNewShippingFormat(dto)) {
    return {
      recipientName: dto.recipientName as string,
      recipientPhone: dto.recipientPhone as string,
      recipientIdDocEnc: null,
      recipientIdDocBlind: null,
      deliveryMode: null,
      shippingAgencyId: null,
      agencyBranchName: null,
      agencyBranchCode: null,
      addressLine1: dto.addressLine1 ?? null,
      addressLine2: dto.addressLine2 ?? null,
      city: dto.city ?? null,
      state: dto.state ?? null,
      municipality: null,
      parish: null,
      referencePoint: null,
      country: 'Venezuela',
    };
  }

  if (dto.customerAddressId !== undefined) {
    // Same error for foreign and nonexistent: no existence oracle.
    if (!customerId || !UUID_RE.test(dto.customerAddressId)) {
      throw addressNotFoundException();
    }
    const addr = await tx.customerAddress.findFirst({
      where: { id: dto.customerAddressId, customerId },
    });
    if (!addr) throw addressNotFoundException();
    const mode = addr.deliveryMode.toLowerCase() as DeliveryModeWire;
    await shipping.assertAgencyUsable(
      addr.agencyId,
      mode,
      { requireActive: true },
      tx,
    );
    // The ciphertext and its blind index are COPIED from the row, never decrypted. A row the
    // backfill has not reached yet (plain only) is encrypted here so the order never stores plain.
    let enc = addr.recipientIdDocEnc;
    let blind = addr.recipientIdDocBlind;
    if (!enc && addr.recipientIdDoc) {
      const p = idDoc.crypto.protect(addr.recipientIdDoc);
      enc = p?.enc ?? null;
      blind = p?.blind ?? null;
    }
    return {
      recipientName: addr.recipientName,
      recipientPhone: addr.recipientPhone,
      recipientIdDocEnc: enc,
      recipientIdDocBlind: blind,
      deliveryMode: addr.deliveryMode,
      shippingAgencyId: addr.agencyId,
      agencyBranchName: addr.agencyBranchName,
      agencyBranchCode: addr.agencyBranchCode,
      addressLine1: addr.addressLine1,
      addressLine2: addr.addressLine2,
      city: addr.municipality, // A50
      state: addr.state,
      municipality: addr.municipality,
      parish: addr.parish,
      referencePoint: addr.referencePoint,
      country: 'Venezuela',
    };
  }

  const checked = validateShippingInput({
    ...dto,
    deliveryMode: dto.deliveryMode as DeliveryModeWire | undefined,
  });
  const errors: ShippingFieldError[] = [...(checked.errors ?? [])];
  const agencyId = dto.shippingAgencyId?.trim() ?? '';
  if (agencyId === '')
    errors.push({ field: 'shippingAgencyId', code: 'REQUIRED' });
  for (const [field, max] of Object.entries(MAX_LEN)) {
    const v = (dto as unknown as Record<string, unknown>)[field];
    if (typeof v === 'string' && v.trim().length > max) {
      errors.push({ field, code: 'INVALID' });
    }
  }
  if (errors.length > 0 || !checked.value) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'SHIPPING_INVALID',
      'The shipping data is invalid.',
      { errors },
    );
  }
  if (!UUID_RE.test(agencyId)) throw agencyUnavailableException();
  await shipping.assertAgencyUsable(
    agencyId,
    checked.value.deliveryMode,
    { requireActive: true },
    tx,
  );
  return fromValue(checked.value, agencyId, idDoc);
}
