import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckoutOrderLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  productName: string;

  @ApiProperty({ example: 89.99, description: 'Snapshotted unit price (USD).' })
  unitPriceUsd: number;

  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiProperty({
    example: 179.98,
    description: 'Snapshotted line total (USD).',
  })
  lineTotalUsd: number;
}

/**
 * Story 4.1: the store's Pago Móvil receiving-account details, plus a
 * per-order `reference` the buyer should cite on the transfer (the Order
 * id itself — simple, unique, and already something the buyer will see
 * elsewhere in this same response). The account fields are placeholder
 * values (see `pago-movil-instructions.constant.ts`) — a known, documented
 * gap, not this story's to resolve.
 */
export class PagoMovilInstructionsDto {
  @ApiProperty({
    example: 'Banco Mercantil (0105) — PLACEHOLDER, not a real account',
  })
  bankName: string;

  @ApiProperty({ example: 'J-00000000-0' })
  idNumber: string;

  @ApiProperty({ example: '0412-0000000' })
  phone: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Reference the buyer should cite on the Pago Móvil transfer — this is the new Order id.',
  })
  reference: string;
}

/**
 * Story 4.3: the PayPal-specific half of a successful `POST /api/v1/checkout`
 * response (`paymentRail=paypal` only — `null` for a Pago Móvil checkout,
 * exactly mirroring how `paymentInstructions` is `null` for a PayPal one).
 * `approveUrl` is what the frontend redirects the buyer to; with the real
 * `@paypal/paypal-server-sdk` client this is PayPal's own hosted-checkout
 * URL, and with the (currently active, in this environment — see the Story
 * 4.3 Dev report) `FakePaypalClient` it is a structurally equivalent
 * placeholder that is never actually reachable.
 */
export class PaypalCheckoutSessionDto {
  @ApiProperty({
    description:
      "PayPal's own order id for this checkout — also persisted on Order.paypalOrderId, and what the confirmation webhook maps back to this Order.",
  })
  paypalOrderId: string;

  @ApiProperty({
    description: 'Redirect the buyer here to approve payment on PayPal.',
  })
  approveUrl: string;
}

/**
 * Story 4.1: response body of a successful `POST /api/v1/checkout`.
 * `orderAccessToken` is the one-time opaque token (AD-17) — this is the
 * ONLY time the raw value is ever exposed; only its SHA-256 hash is
 * persisted (`Order.accessTokenHash`). The buyer must save it themselves
 * (e.g. Story 4.2's Proof-of-Payment upload, Story 5.1's order lookup, both
 * out of this story's scope, will require it).
 *
 * Story 4.3 (AD-3): `fxRateVesPerUsd`/`totalVes`/`paymentInstructions` are
 * `null` for a `paymentRail=paypal` checkout (PayPal orders never touch
 * VES); `paypal` is `null` for a `paymentRail=pago_movil` checkout instead.
 * Exactly one of `paymentInstructions`/`paypal` is ever non-null on any
 * given response — which one tells the frontend which flow to render.
 */
export class CheckoutResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({
    example: 'pending_verification',
    description:
      'The Order status immediately after checkout (AD-7): "pending_verification" for pago_movil, "payment_processing" for paypal.',
  })
  status: string;

  @ApiProperty({ example: 179.98 })
  totalUsd: number;

  @ApiPropertyOptional({
    example: 40.5,
    nullable: true,
    description:
      'VES per 1 USD, snapshotted once from the admin-maintained rate at checkout time (AD-3/AD-4) — never recomputed later. Null for a paypal checkout.',
  })
  fxRateVesPerUsd: number | null;

  @ApiPropertyOptional({
    example: 7289.19,
    nullable: true,
    description: 'Null for a paypal checkout.',
  })
  totalVes: number | null;

  @ApiProperty({ type: [CheckoutOrderLineResponseDto] })
  lines: CheckoutOrderLineResponseDto[];

  @ApiPropertyOptional({
    type: PagoMovilInstructionsDto,
    nullable: true,
    description: 'Present only for paymentRail=pago_movil; null for paypal.',
  })
  paymentInstructions: PagoMovilInstructionsDto | null;

  @ApiPropertyOptional({
    type: PaypalCheckoutSessionDto,
    nullable: true,
    description: 'Present only for paymentRail=paypal; null for pago_movil.',
  })
  paypal: PaypalCheckoutSessionDto | null;

  @ApiProperty({
    description:
      'One-time opaque order access token (AD-17). Returned ONLY here — only its hash is persisted server-side. Required for any later buyer action on this Order (Proof of Payment upload, status lookup).',
    example: 'b6f1e2...9a3c (64 hex chars)',
  })
  orderAccessToken: string;
}
