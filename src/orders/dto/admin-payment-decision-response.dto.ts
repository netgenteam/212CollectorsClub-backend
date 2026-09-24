import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 9.2 (AD-7, AD-13, AD-16). Response shape shared by
 * `POST .../confirm-payment` and `POST .../reject-payment`. Deliberately
 * minimal — the caller already knows which action it invoked and the
 * Order's line items/totals are already visible via Story 9.1's list or a
 * direct order lookup, so this only confirms the outcome: which Order,
 * which resulting status, and when the guarded transaction that produced
 * it actually committed (`updatedAt` is re-read from the DB row after
 * commit, not `Date.now()` at the call site, so it always matches the
 * `OrderStatusHistory` row and `Order.updatedAt` exactly).
 */
export class AdminPaymentDecisionResponseDto {
  @ApiProperty({ example: '3f9e2b1a-6c4d-4e7f-9a1b-c1a2d3e4f5a6' })
  orderId: string;

  @ApiProperty({
    example: 'paid',
    enum: ['paid', 'payment_rejected'],
    description: 'The Order status AFTER this decision was applied.',
  })
  status: string;

  @ApiProperty({ example: '2026-09-24T18:03:11.000Z' })
  updatedAt: string;
}
