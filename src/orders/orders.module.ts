import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ProofOfPaymentController } from './proof-of-payment.controller.js';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { OrderLookupController } from './order-lookup.controller.js';
import { OrderLookupService } from './order-lookup.service.js';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';
import { StockHoldExpiryCronService } from './cron/stock-hold-expiry-cron.service.js';
import { PaymentProcessingTimeoutCronService } from './cron/payment-processing-timeout-cron.service.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { AdminOrderPaymentService } from './admin-order-payment.service.js';

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
//
// Story 9.1 (AD-11, AD-14): `AdminOrdersController`/`-Service` add the
// first `AdminAuthGuard`-gated route to THIS module (§4.9 admin order
// management — AD-14 requires it live here, not a separate `AdminOrders`
// module, unlike Epic 8's `admin-catalog/`). `AdminAuthGuard extends
// AuthGuard('admin-jwt')`, and `@nestjs/passport`'s `AuthGuard()` mixin has
// its own DI dependency on an `AuthModuleOptions` provider that's scoped
// per-module — `AdminAuthModule` registering `PassportModule` for itself
// does NOT make that provider reachable from a guard instantiated inside a
// different module (confirmed empirically in Story 8.1, see
// `admin-catalog.module.ts`'s and `AdminAuthGuard`'s own doc comments for
// the full writeup). `OrdersModule` never needed this before — its two
// pre-existing controllers use the unrelated hand-rolled
// `OrderAccessTokenGuard` — so this `PassportModule.register(...)` import
// is new as of this story, added for exactly the same one-line reason
// every Epic 8/9/10 module gains it.
//
// Story 9.2: `AdminOrderPaymentService` (proof-of-payment file serving +
// confirm/reject) is a sibling provider to `AdminOrdersService`, both
// consumed by the SAME `AdminOrdersController` — no new controller, no new
// module (same AD-14 reasoning Story 9.1 already established for this
// module as a whole).
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [
    ProofOfPaymentController,
    OrderLookupController,
    AdminOrdersController,
  ],
  providers: [
    ProofOfPaymentService,
    OrderLookupService,
    OrderAccessTokenGuard,
    StockHoldExpiryCronService,
    PaymentProcessingTimeoutCronService,
    AdminOrdersService,
    AdminOrderPaymentService,
  ],
  exports: [StockHoldExpiryCronService, PaymentProcessingTimeoutCronService],
})
export class OrdersModule {}
