import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaypalPaymentsService } from './paypal-payments.service.js';
import { PaypalWebhookEventDto } from './dto/paypal-webhook-event.dto.js';
import { PaypalWebhookAckDto } from './dto/paypal-webhook-ack.dto.js';

@ApiTags('payments')
@Controller('payments/paypal')
export class PaypalWebhookController {
  constructor(private readonly paypalPayments: PaypalPaymentsService) {}

  /**
   * Story 4.3 (AC2-AC4). See `PaypalPaymentsService`'s own doc comment for
   * why this is modeled as a webhook receiver, why the request body's own
   * claimed outcome is never trusted, and why every outcome this endpoint
   * can meaningfully act on — including an already-resolved duplicate —
   * returns HTTP 200 rather than a 404/409 that would make PayPal retry a
   * webhook that was already handled correctly.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'PayPal payment confirmation (webhook / server-side verification)',
    description:
      "Receives a PayPal payment-outcome notification for a paypalOrderId (in production, PayPal's own webhook delivery for this Order's checkout — see the Story 4.3 Dev report for the exact real-webhook-envelope mapping this endpoint assumes has already happened upstream). The backend NEVER trusts this request body's own claimed outcome — it independently re-verifies by calling PayPal itself (via the injected PaypalClient) and acts only on THAT response. On a verified COMPLETED payment: guarded payment_processing->paid transition + atomic stock decrement (AD-13) in one transaction. On anything else: guarded payment_processing->payment_failed transition, stock never touched. A duplicate/late event for an Order that already left payment_processing is a safe no-op (outcome=noop) — never a stock double-decrement, never a non-2xx that would make PayPal retry needlessly.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: PaypalWebhookAckDto,
    description:
      'Always 200 for any event this endpoint can act on, including outcome=noop (duplicate/late event) and outcome=payment_failed.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'errorCode PAYPAL_ORDER_NOT_FOUND — no Order in this system is associated with the given paypalOrderId.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      "errorCode PAYPAL_VERIFICATION_MISMATCH — PayPal's own verification response echoed a different internal Order id than the one this paypalOrderId is mapped to locally. Nothing is mutated.",
  })
  async webhook(
    @Body() dto: PaypalWebhookEventDto,
  ): Promise<PaypalWebhookAckDto> {
    const outcome = await this.paypalPayments.confirmPayment(
      dto.paypalOrderId,
      dto.eventType,
    );
    return { received: true, outcome };
  }
}
