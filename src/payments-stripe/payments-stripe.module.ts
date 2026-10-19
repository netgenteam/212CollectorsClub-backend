import { Module } from '@nestjs/common';
import { FakeStripeClient } from './fake-stripe-client.js';
import { stripeClientProvider } from './stripe-client.provider.js';
import { STRIPE_CLIENT } from './stripe-client.interface.js';

// Story 14.3 (AD-45). No controller yet (webhook arrives in 14.5).
@Module({
  providers: [FakeStripeClient, stripeClientProvider],
  exports: [STRIPE_CLIENT, FakeStripeClient],
})
export class PaymentsStripeModule {}
