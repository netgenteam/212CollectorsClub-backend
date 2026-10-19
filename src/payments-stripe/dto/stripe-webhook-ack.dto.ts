import { ApiProperty } from '@nestjs/swagger';

export const STRIPE_WEBHOOK_OUTCOMES = [
  'paid',
  'failed',
  'noop',
  'ignored',
  'duplicate',
  'unknown_order',
  'amount_mismatch',
  'no_stock',
] as const;
export type StripeWebhookOutcome = (typeof STRIPE_WEBHOOK_OUTCOMES)[number];

/** Story 14.5 (AD-47): 2xx ack for every verified event, whatever its outcome. */
export class StripeWebhookAckDto {
  @ApiProperty({ example: true })
  received: boolean;

  @ApiProperty({
    enum: STRIPE_WEBHOOK_OUTCOMES,
    example: 'paid',
    description:
      '"paid": PAYMENT_PROCESSING->PAID and stock decremented. "failed": PAYMENT_PROCESSING->PAYMENT_FAILED. "noop": order already left PAYMENT_PROCESSING or payment still unpaid. "ignored": event type not handled. "duplicate": event id already processed. "unknown_order": no order for the session. "amount_mismatch": amount/currency differ from the order, order untouched. "no_stock": paid but stock exhausted, rolled back (manual refund required).',
  })
  outcome: StripeWebhookOutcome;
}
