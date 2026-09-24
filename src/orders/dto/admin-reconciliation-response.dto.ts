import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Story 9.4 AC1: one (Payment Rail, Order status) group within the period —
 * `paymentRail` on every single entry is exactly what makes the Rail
 * "distinguishable per entry, at a glance" (the AC's own wording), and
 * splitting by `status` too (rather than collapsing straight to one row
 * per rail) is what makes this actually useful for reconciliation: an
 * admin needs to see "paid" totals separately from "payment_rejected" /
 * "expired" / "payment_failed" ones, not a single number that conflates
 * money actually collected with money that was only ever attempted.
 */
export class ReconciliationBreakdownEntryDto {
  @ApiProperty({ example: 'pago_movil', enum: ['pago_movil', 'paypal'] })
  paymentRail: string;

  @ApiProperty({
    example: 'paid',
    description: "The Order's AD-7 status, lowercased, for this group.",
  })
  status: string;

  @ApiProperty({ example: 4, description: 'Number of Orders in this group.' })
  orderCount: number;

  @ApiProperty({
    example: 359.96,
    description: 'Sum of Order.totalUsd across this group.',
  })
  totalUsd: number;

  @ApiPropertyOptional({
    example: 14578.38,
    nullable: true,
    description:
      'Sum of Order.totalVes across this group. Always null for paymentRail=paypal (AD-3 never populates VES for PayPal Orders).',
  })
  totalVes: number | null;
}

/** Same shape as one breakdown entry, minus `status` — the per-rail
 * subtotal across every status in the period. */
export class ReconciliationRailTotalDto {
  @ApiProperty({ example: 'pago_movil', enum: ['pago_movil', 'paypal'] })
  paymentRail: string;

  @ApiProperty({ example: 6 })
  orderCount: number;

  @ApiProperty({ example: 611.94 })
  totalUsd: number;

  @ApiPropertyOptional({ example: 24488.28, nullable: true })
  totalVes: number | null;
}

export class ReconciliationGrandTotalDto {
  @ApiProperty({ example: 10 })
  orderCount: number;

  @ApiProperty({ example: 971.9 })
  totalUsd: number;

  @ApiPropertyOptional({
    example: 24488.28,
    nullable: true,
    description:
      'Sum of Order.totalVes across every Order in the period, regardless of rail (paypal Orders never contribute — see AD-3). Null when the period has zero pago_movil Orders.',
  })
  totalVes: number | null;
}

/**
 * Story 9.4 AC1/AC3: response for
 * `GET /api/v1/admin/orders/reconciliation?from=...&to=...`. A period with
 * no payments returns this same shape with empty arrays and a zeroed
 * `grandTotal` — never an error (same always-200-on-no-match criterion
 * `PaginatedAdminOrdersResponseDto`, Story 9.1, and `PaginatedProductsResponseDto`,
 * Story 2.2, already establish for this codebase).
 */
export class AdminReconciliationResponseDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-09-30T23:59:59.999Z' })
  to: string;

  @ApiProperty({
    type: ReconciliationBreakdownEntryDto,
    isArray: true,
    description: 'One entry per (paymentRail, status) group in the period.',
  })
  breakdown: ReconciliationBreakdownEntryDto[];

  @ApiProperty({
    type: ReconciliationRailTotalDto,
    isArray: true,
    description: 'One entry per paymentRail, summed across every status.',
  })
  totalsByRail: ReconciliationRailTotalDto[];

  @ApiProperty({ type: ReconciliationGrandTotalDto })
  grandTotal: ReconciliationGrandTotalDto;
}
