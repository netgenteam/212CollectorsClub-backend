import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Story 4.1 (FR-12) introduced `pago_movil`; Story 4.3 adds `paypal` —
 * both are now legal `paymentRail` values, and `CheckoutService` branches
 * on which one was sent (stock-hold-then-pending_verification for
 * pago_movil, no-hold-then-payment_processing-plus-a-PayPal-order for
 * paypal — see that service's own doc comment).
 *
 * Deliberately lowercase-snake wire values (`pago_movil`, `paypal`), NOT
 * the internal Prisma `PaymentRail` enum's UPPER_SNAKE keys (`PAGO_MOVIL`,
 * `PAYPAL`) — the story's own Acceptance Criteria spell the wire value as
 * `paymentRail=pago_movil`/`paymentRail=paypal` verbatim (unlike Story
 * 2.2's catalog filters, which exposed the Prisma enum's own UPPER_SNAKE
 * values directly on the wire). This DTO enum is the wire contract;
 * `CheckoutService` maps it onto the Prisma enum when persisting.
 */
export enum CheckoutPaymentRail {
  PAGO_MOVIL = 'pago_movil',
  PAYPAL = 'paypal',
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
      'Payment rail for this checkout. "pago_movil" (Story 4.1) creates a stock hold and enters pending_verification. "paypal" (Story 4.3) never holds stock, enters payment_processing, and the response includes a paypal.approveUrl to redirect the buyer to.',
  })
  @IsEnum(CheckoutPaymentRail)
  paymentRail: CheckoutPaymentRail;

  @ApiProperty({
    enum: CheckoutFulfillmentType,
    example: CheckoutFulfillmentType.DELIVERY,
    description:
      'How the order reaches the buyer. "delivery" requires a full Venezuela address below; "pickup" requires none of it.',
  })
  @IsEnum(CheckoutFulfillmentType)
  fulfillmentType: CheckoutFulfillmentType;

  @ApiProperty({
    example: 'Maria Perez',
    description: 'Full name of the person receiving the order.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  recipientName: string;

  @ApiProperty({
    example: '+58 412-1234567',
    description: 'Contact phone number for the recipient.',
    maxLength: 30,
  })
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
  @ValidateIf(
    (o: CheckoutDto) => o.fulfillmentType === CheckoutFulfillmentType.DELIVERY,
  )
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
  @ValidateIf(
    (o: CheckoutDto) => o.fulfillmentType === CheckoutFulfillmentType.DELIVERY,
  )
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
  @ValidateIf(
    (o: CheckoutDto) => o.fulfillmentType === CheckoutFulfillmentType.DELIVERY,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state?: string;
}
