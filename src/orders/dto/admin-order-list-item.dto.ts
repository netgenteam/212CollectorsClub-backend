import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Story 9.1 AC1: one row of `GET /api/v1/admin/orders` — a summary shape
 * (no `OrderLine[]`, unlike `OrderDetailResponseDto` from Story 5.1) since
 * a list view never needs per-line detail and fetching lines for every row
 * here would be an N+1 this story's Technical Notes don't call for. An
 * Admin who needs the full line-item breakdown for one Order already has
 * `GET /api/v1/orders/{orderId}` (Story 5.1, `OrderLookupService.getDetail`
 * — reachable by the same JWT the buyer flow already documents extending
 * to Admins) for that.
 */
export class AdminOrderListItemDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({
    example: 'pending_verification',
    description: "The Order's current AD-7 status, lowercased.",
  })
  status: string;

  @ApiProperty({ example: 'pago_movil', enum: ['pago_movil', 'paypal'] })
  paymentRail: string;

  @ApiProperty({ example: 'pickup', enum: ['delivery', 'pickup'] })
  fulfillmentType: string;

  @ApiProperty({ example: 'Maria Perez' })
  recipientName: string;

  @ApiProperty({ example: 179.98 })
  totalUsd: number;

  @ApiPropertyOptional({
    example: 7289.19,
    nullable: true,
    description: 'Null for a paypal Order (AD-3).',
  })
  totalVes: number | null;

  @ApiProperty({ example: '2026-09-24T17:41:08.000Z' })
  createdAt: string;

  @ApiProperty({
    example: '2026-09-24T17:45:12.000Z',
    description:
      'Last time this Order row changed (e.g. its last status transition).',
  })
  updatedAt: string;
}
