import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Story 5.1 (AD-8): the fulfillment/delivery details captured once at
 * Story 4.1 checkout, read back here unchanged. `addressLine1`/
 * `addressLine2`/`city`/`state`/`country` are always null for a `pickup`
 * Order and always populated for a `delivery` one — the exact same
 * conditional-population rule `Order` itself documents in
 * `schema.prisma`, just mirrored on the way out instead of in.
 */
export class OrderFulfillmentDto {
  @ApiProperty({
    example: 'delivery',
    enum: ['delivery', 'pickup'],
    description: 'AD-8 fulfillment type, lowercased.',
  })
  type: string;

  @ApiProperty({ example: 'Maria Perez' })
  recipientName: string;

  @ApiProperty({ example: '0412-1234567' })
  recipientPhone: string;

  @ApiPropertyOptional({
    example: 'Av. Francisco de Miranda, Torre A, Piso 4',
    nullable: true,
    description: 'Null when fulfillment type is "pickup".',
  })
  addressLine1: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when fulfillment type is "pickup".',
  })
  addressLine2: string | null;

  @ApiPropertyOptional({
    example: 'Caracas',
    nullable: true,
    description: 'Null when fulfillment type is "pickup".',
  })
  city: string | null;

  @ApiPropertyOptional({
    example: 'Distrito Capital',
    nullable: true,
    description: 'Null when fulfillment type is "pickup".',
  })
  state: string | null;

  @ApiPropertyOptional({
    example: 'Venezuela',
    nullable: true,
    description: 'Null when fulfillment type is "pickup".',
  })
  country: string | null;
}

/** One snapshotted Order line — the exact same shape/values the Story 4.1
 * checkout response already returned once; repeated here so a buyer who
 * lost that original response can still see what they ordered. */
export class OrderLookupLineDto {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  productName: string;

  @ApiProperty({ example: 89.99 })
  unitPriceUsd: number;

  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiProperty({ example: 179.98 })
  lineTotalUsd: number;
}

/**
 * Story 5.1 AC1: response body of `GET /api/v1/orders/{orderId}`. Covers
 * FR-13's retrievability requirement — mirrors most of Story 4.1's
 * `CheckoutResponseDto`, minus the one field that must NEVER be echoed
 * back: `orderAccessToken` itself (only its hash is persisted; re-showing
 * it here would defeat the point of a one-time token).
 */
export class OrderDetailResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({
    example: 'pending_verification',
    description: "The Order's current AD-7 status, lowercased.",
  })
  status: string;

  @ApiProperty({ example: 'pago_movil', enum: ['pago_movil', 'paypal'] })
  paymentRail: string;

  @ApiProperty({ type: OrderFulfillmentDto })
  fulfillment: OrderFulfillmentDto;

  @ApiProperty({ example: 179.98 })
  totalUsd: number;

  @ApiPropertyOptional({
    example: 40.5,
    nullable: true,
    description: 'Null for a paypal Order (AD-3).',
  })
  fxRateVesPerUsd: number | null;

  @ApiPropertyOptional({
    example: 7289.19,
    nullable: true,
    description: 'Null for a paypal Order (AD-3).',
  })
  totalVes: number | null;

  @ApiProperty({ type: [OrderLookupLineDto] })
  lines: OrderLookupLineDto[];

  @ApiProperty({ example: '2026-09-24T17:41:08.000Z' })
  createdAt: string;

  @ApiProperty({
    example: '2026-09-24T17:45:12.000Z',
    description:
      'Last time this Order row changed (e.g. its last status transition).',
  })
  updatedAt: string;
}

/**
 * Story 5.1 AC2/AC3: one row of `GET /api/v1/orders/{orderId}/history`.
 * `fromStatus` is null only for the very first row on an Order (its
 * creation transition, `recordInitialOrderStatus` in
 * `common/order-status-transition.ts`) — every later row always has a real
 * prior status.
 */
export class OrderStatusHistoryEntryDto {
  @ApiPropertyOptional({
    example: 'pending_verification',
    nullable: true,
    description: 'Null only on the very first row (Order creation).',
  })
  fromStatus: string | null;

  @ApiProperty({ example: 'paid' })
  toStatus: string;

  @ApiProperty({
    example: 'admin',
    enum: ['system', 'paypal_webhook', 'admin', 'cron'],
  })
  actorType: string;

  @ApiProperty({ example: '2026-09-24T17:45:12.000Z' })
  createdAt: string;
}
