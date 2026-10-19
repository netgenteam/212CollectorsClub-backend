import { ApiProperty } from '@nestjs/swagger';
import { OrderDetailResponseDto } from './order-lookup-response.dto.js';

/** Story 14.5b (AD-50): admin Order detail = buyer detail + refund trace. */
export class AdminOrderDetailResponseDto extends OrderDetailResponseDto {
  @ApiProperty({
    example: false,
    description:
      'True when a Stripe_Webhook_Events row with outcome refund_pending_* exists for this Order: Stripe charged the buyer but the Order could not be paid (no stock / already payment_failed). Refund manually from the Stripe dashboard.',
  })
  refundPending: boolean;
}
