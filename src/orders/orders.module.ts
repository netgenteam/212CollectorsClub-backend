import { Module } from '@nestjs/common';
import { ProofOfPaymentController } from './proof-of-payment.controller.js';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { OrderLookupController } from './order-lookup.controller.js';
import { OrderLookupService } from './order-lookup.service.js';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';
import { StockHoldExpiryCronService } from './cron/stock-hold-expiry-cron.service.js';
import { PaymentProcessingTimeoutCronService } from './cron/payment-processing-timeout-cron.service.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here (same pattern CheckoutModule already uses).
//
// Story 5.1: OrderLookupController/-Service added alongside the Story 4.2
// proof-of-payment pair, both sharing the SAME OrderAccessTokenGuard
// instance registered once here.
//
// Story 5.2: the two `@Cron` services live here too — no new controllers,
// they're driven purely by `@nestjs/schedule` (wired globally via
// `ScheduleModule.forRoot()` in AppModule) plus direct method calls from
// tests. Both exported (not strictly required for Nest's own DI — test
// modules can `get()` any provider in the tree regardless — but exported
// anyway for the same self-documenting reason `PaymentsPaypalModule`
// exports `FakePaypalClient`: it's the explicit, discoverable way for an
// e2e test to say "yes, this provider is meant to be reached from
// outside this module").
@Module({
  controllers: [ProofOfPaymentController, OrderLookupController],
  providers: [
    ProofOfPaymentService,
    OrderLookupService,
    OrderAccessTokenGuard,
    StockHoldExpiryCronService,
    PaymentProcessingTimeoutCronService,
  ],
  exports: [StockHoldExpiryCronService, PaymentProcessingTimeoutCronService],
})
export class OrdersModule {}
