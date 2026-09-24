import { Module } from '@nestjs/common';
import { PaypalWebhookController } from './paypal-webhook.controller.js';
import { PaypalPaymentsService } from './paypal-payments.service.js';
import { FakePaypalClient } from './fake-paypal-client.js';
import { paypalClientProvider } from './paypal-client.provider.js';
import { PAYPAL_CLIENT } from './paypal-client.interface.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here (same pattern CheckoutModule/OrdersModule already
// use). `PAYPAL_CLIENT` and `FakePaypalClient` are BOTH exported: the
// former for any module that needs to inject the currently-active
// PaypalClient (CheckoutModule does, for the checkout-time createOrder
// call); the latter so e2e tests can `app.get(FakePaypalClient)` and
// script it directly (see FakePaypalClient's own doc comment).
@Module({
  controllers: [PaypalWebhookController],
  providers: [FakePaypalClient, paypalClientProvider, PaypalPaymentsService],
  exports: [PAYPAL_CLIENT, FakePaypalClient],
})
export class PaymentsPaypalModule {}
