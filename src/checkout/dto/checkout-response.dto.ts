import { ApiProperty } from '@nestjs/swagger';

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
 * Story 4.1: response body of a successful `POST /api/v1/checkout`.
 * `orderAccessToken` is the one-time opaque token (AD-17) — this is the
 * ONLY time the raw value is ever exposed; only its SHA-256 hash is
 * persisted (`Order.accessTokenHash`). The buyer must save it themselves
 * (e.g. Story 4.2's Proof-of-Payment upload, Story 5.1's order lookup, both
 * out of this story's scope, will require it).
 */
export class CheckoutResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({
    example: 'pending_verification',
    description: 'The Order status immediately after checkout (AD-7).',
  })
  status: string;

  @ApiProperty({ example: 179.98 })
  totalUsd: number;

  @ApiProperty({
    example: 40.5,
    description:
      'VES per 1 USD, snapshotted once from the admin-maintained rate at checkout time (AD-3/AD-4) — never recomputed later.',
  })
  fxRateVesPerUsd: number;

  @ApiProperty({ example: 7289.19 })
  totalVes: number;

  @ApiProperty({ type: [CheckoutOrderLineResponseDto] })
  lines: CheckoutOrderLineResponseDto[];

  @ApiProperty({ type: PagoMovilInstructionsDto })
  paymentInstructions: PagoMovilInstructionsDto;

  @ApiProperty({
    description:
      'One-time opaque order access token (AD-17). Returned ONLY here — only its hash is persisted server-side. Required for any later buyer action on this Order (Proof of Payment upload, status lookup).',
    example: 'b6f1e2...9a3c (64 hex chars)',
  })
  orderAccessToken: string;
}
