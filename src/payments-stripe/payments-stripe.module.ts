import { Module } from '@nestjs/common';
import { FakeStripeClient } from './fake-stripe-client.js';
import { stripeClientProvider } from './stripe-client.provider.js';
import { STRIPE_CLIENT } from './stripe-client.interface.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';
import { StripePaymentsService } from './stripe-payments.service.js';

// Story 14.3 (AD-45) client providers + Story 14.5 (AD-47) webhook.
@Module({
  controllers: [StripeWebhookController],
  providers: [FakeStripeClient, stripeClientProvider, StripePaymentsService],
  exports: [STRIPE_CLIENT, FakeStripeClient],
})
export class PaymentsStripeModule {}
