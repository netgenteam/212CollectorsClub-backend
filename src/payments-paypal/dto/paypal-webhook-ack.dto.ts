import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 4.3 (AC4): always returned with HTTP 200, for every outcome this
 * endpoint can meaningfully act on — including a duplicate/already-
 * resolved event (`outcome=noop`) — so PayPal never sees a reason to keep
 * retrying an event this system already handled. `outcome` is purely
 * informational for the caller (PayPal ignores the response body); this
 * codebase's own e2e tests assert on it directly instead of re-querying
 * the Order afterward for the common-path assertions.
 */
export class PaypalWebhookAckDto {
  @ApiProperty({ example: true })
  received: boolean;

  @ApiProperty({
    enum: ['paid', 'payment_failed', 'noop'],
    example: 'paid',
    description:
      '"paid": the Order transitioned payment_processing->paid and stock was decremented. "payment_failed": the Order transitioned payment_processing->payment_failed. "noop": the Order had already left payment_processing (a duplicate/late event, or an out-of-order one) — nothing was changed, per this story\'s idempotency requirement.',
  })
  outcome: 'paid' | 'payment_failed' | 'noop';
}
