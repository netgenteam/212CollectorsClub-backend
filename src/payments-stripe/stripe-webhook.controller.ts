import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiException } from '../common/api-exception.js';
import {
  STRIPE_CLIENT,
  StripeSignatureError,
} from './stripe-client.interface.js';
import type { StripeClient } from './stripe-client.interface.js';
import { StripePaymentsService } from './stripe-payments.service.js';
import { StripeWebhookAckDto } from './dto/stripe-webhook-ack.dto.js';

/**
 * Story 14.5 (AD-47). Public on purpose: authenticity comes from the
 * `Stripe-Signature` header verified over the raw body, before any DB access.
 */
@ApiTags('payments')
@Controller('payments/stripe')
export class StripeWebhookController {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripeClient: StripeClient,
    private readonly stripePayments: StripePaymentsService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stripe webhook (signature-verified, idempotent)',
    description:
      'Handles checkout.session.completed (paid), checkout.session.async_payment_succeeded, checkout.session.async_payment_failed and checkout.session.expired. Verifies Stripe-Signature over the raw body; every verified event is acknowledged with 200 regardless of outcome so Stripe does not retry needlessly.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: StripeWebhookAckDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode STRIPE_SIGNATURE_INVALID - missing, malformed, wrong-secret or stale signature.',
  })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<StripeWebhookAckDto> {
    let event;
    try {
      event = this.stripeClient.parseWebhook(req.rawBody as Buffer, signature);
    } catch (err) {
      if (err instanceof StripeSignatureError) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'STRIPE_SIGNATURE_INVALID',
          'Invalid Stripe webhook signature.',
        );
      }
      throw err;
    }
    const outcome = await this.stripePayments.handleEvent(event);
    return { received: true, outcome };
  }
}
