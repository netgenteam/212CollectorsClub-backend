import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { isNewShippingFormat } from '../checkout-shipping.js';

/**
 * Legal `paymentRail` values: `pago_movil` (stock-hold then
 * pending_verification) and `stripe` (stock-hold then payment_processing
 * plus a Stripe Checkout Session) — see `CheckoutService`. Any other
 * value is a 400 (the third-party rail retired in Story 14.6, AD-49).
 *
 * Deliberately lowercase-snake wire values (`pago_movil`, `stripe`), NOT
 * the internal Prisma `PaymentRail` enum's UPPER_SNAKE keys.
 * `CheckoutService` maps it onto the Prisma enum when persisting.
 */
export enum CheckoutPaymentRail {
  PAGO_MOVIL = 'pago_movil',
  /** Story 14.4 (AD-46): Stripe Checkout Session. */
  STRIPE = 'stripe',
}

/**
 * Same reasoning as `CheckoutPaymentRail` above — lowercase wire values
 * matching the story's Acceptance Criteria text (`delivery`/`pickup`),
 * mapped onto the Prisma `FulfillmentType` enum (`DELIVERY`/`PICKUP`) by
 * `CheckoutService`.
 */
export enum CheckoutFulfillmentType {
  DELIVERY = 'delivery',
  PICKUP = 'pickup',
}

/** Story 17.4 (AD-74): any new-format shipping field (or a saved address) present. */
export function isNewFormat(o: CheckoutDto): boolean {
  return isNewShippingFormat(o);
}

const isNotPickup = (o: CheckoutDto): boolean =>
  o.fulfillmentType !== CheckoutFulfillmentType.PICKUP;

/** Legacy flat address fields: only for delivery in the old flat format. */
const requiresLegacyAddress = (o: CheckoutDto): boolean =>
  isNotPickup(o) && !isNewFormat(o);

/**
 * Recipient name/phone are required in the flat format; with the new format
 * they are validated by the shipping rules (400 SHIPPING_INVALID) or come
 * from the saved address.
 */
const requiresFlatRecipient = (o: CheckoutDto): boolean =>
  !o.customerAddressId && !isNewFormat(o);

/**
 * Story 4.1 (FR-12, FR-13, AD-8): body of `POST /api/v1/checkout`.
 *
 * Conditional validation via `@ValidateIf` implements this story's own
 * Acceptance Criterion — "missing recipientName, or missing both an
 * address and an explicit pickup selection -> reject" — entirely at the
 * DTO layer, the same "malformed/invalid input never reaches the Service"
 * pattern (NFR-3) every earlier story's DTOs already use:
 *
 * - `fulfillmentType` is `@IsEnum` and required (not `@IsOptional`), so
 *   omitting it entirely — no explicit pickup or delivery selection — is
 *   already a stable 400 before any other field on this DTO is even
 *   considered.
 * - `addressLine1`/`city`/`state` are `@ValidateIf(fulfillmentType ===
 *   delivery)` — required (and validated as non-empty strings) only when
 *   `fulfillmentType = delivery`; entirely skipped (no error, no value
 *   expected) when `fulfillmentType = pickup`.
 * - `country` is deliberately NOT a field here at all. AD-8 constrains MVP
 *   delivery to Venezuela only — there is exactly one legal value — so
 *   `CheckoutService` hardcodes `country = "Venezuela"` server-side for
 *   delivery orders instead of trusting/validating buyer input for a field
 *   with a single possible answer. This also means a delivery checkout can
 *   never end up with a missing/misspelled country.
 * - `addressLine2` is the one always-optional address field (an
 *   apartment/suite line), even under `fulfillmentType = delivery`.
 */
export class CheckoutDto {
  @ApiProperty({
    enum: CheckoutPaymentRail,
    example: CheckoutPaymentRail.PAGO_MOVIL,
    description:
      'Payment rail for this checkout. "pago_movil" (Story 4.1) creates a stock hold and enters pending_verification. "stripe" (Story 14.4/14.5b) reserves stock, enters payment_processing, and the response includes stripe.url (Stripe-hosted payment page) to redirect the buyer to; the amount is always computed server-side.',
  })
  @IsEnum(CheckoutPaymentRail)
  paymentRail: CheckoutPaymentRail;

  @ApiPropertyOptional({
    enum: CheckoutFulfillmentType,
    default: CheckoutFulfillmentType.DELIVERY,
    description:
      'Defaults to "delivery". "pickup" is RETIRED (Story 17.4): it is still accepted by the validator but answers 400 PICKUP_NOT_SUPPORTED.',
  })
  @IsOptional()
  @IsEnum(CheckoutFulfillmentType)
  fulfillmentType?: CheckoutFulfillmentType;

  @ApiPropertyOptional({
    example: 'Maria Perez',
    description:
      'Full name of the person receiving the order. Ignored when customerAddressId is sent.',
    maxLength: 200,
  })
  @ValidateIf(requiresFlatRecipient)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  recipientName: string;

  @ApiPropertyOptional({
    example: '+58 412-1234567',
    description:
      'Contact phone number for the recipient. Ignored when customerAddressId is sent.',
    maxLength: 30,
  })
  @ValidateIf(requiresFlatRecipient)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  recipientPhone: string;

  @ApiPropertyOptional({
    example: 'Av. Francisco de Miranda, Torre A, Piso 4',
    description:
      'Required when fulfillmentType = delivery; not accepted/validated otherwise.',
    maxLength: 200,
  })
  @ValidateIf(requiresLegacyAddress)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({
    example: 'Apto 4B',
    description:
      'Optional second address line (apartment/suite/etc). Always optional, even under delivery.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({
    example: 'Caracas',
    description:
      'Required when fulfillmentType = delivery; not accepted/validated otherwise.',
    maxLength: 100,
  })
  @ValidateIf(requiresLegacyAddress)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: 'Distrito Capital',
    description:
      'Venezuela state/estado. Required when fulfillmentType = delivery; not accepted/validated otherwise.',
    maxLength: 100,
  })
  @ValidateIf(requiresLegacyAddress)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({
    description:
      'Saved address of the logged-in customer (Story 17.4). Prevails over every explicit shipping field. Requires a session.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerAddressId?: string;

  @ApiPropertyOptional({
    description:
      'Recipient national ID, e.g. V-12345678 (new shipping format).',
    maxLength: 30,
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  recipientIdDoc?: string;

  @ApiPropertyOptional({
    enum: ['agency_office', 'home_delivery'],
    description: 'Delivery mode (new shipping format).',
  })
  @IsOptional()
  @IsIn(['agency_office', 'home_delivery'])
  deliveryMode?: 'agency_office' | 'home_delivery';

  @ApiPropertyOptional({
    description: 'Shipping agency id (new shipping format).',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  shippingAgencyId?: string;

  @ApiPropertyOptional({ description: 'Agency branch name.', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  agencyBranchName?: string;

  @ApiPropertyOptional({ description: 'Agency branch code.', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  agencyBranchCode?: string;

  @ApiPropertyOptional({
    description:
      'Municipality; also stored as the order city (new shipping format).',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  municipality?: string;

  @ApiPropertyOptional({ description: 'Parish.', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parish?: string;

  @ApiPropertyOptional({
    description: 'Delivery reference point.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  referencePoint?: string;
}
