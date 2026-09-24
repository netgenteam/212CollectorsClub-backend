import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 9.3 (AD-7, AD-16). Response shape shared by `POST .../fulfill` and
 * `POST .../cancel` — deliberately the same minimal shape as Story 9.2's
 * `AdminPaymentDecisionResponseDto` (not reused directly: that DTO's `enum`
 * example is scoped to `paid`/`payment_rejected`, this one to
 * `fulfilled`/`cancelled` — two distinct decision families with their own
 * legal-status vocab, even though the wire shape is identical). `updatedAt`
 * is re-read from the DB row after commit, not `Date.now()` at the call
 * site, so it always matches the `OrderStatusHistory` row and
 * `Order.updatedAt` exactly.
 */
export class AdminFulfillmentDecisionResponseDto {
  @ApiProperty({ example: '3f9e2b1a-6c4d-4e7f-9a1b-c1a2d3e4f5a6' })
  orderId: string;

  @ApiProperty({
    example: 'fulfilled',
    enum: ['fulfilled', 'cancelled'],
    description: 'The Order status AFTER this decision was applied.',
  })
  status: string;

  @ApiProperty({ example: '2026-09-24T18:03:11.000Z' })
  updatedAt: string;
}
