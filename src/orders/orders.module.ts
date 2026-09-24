import { Module } from '@nestjs/common';
import { ProofOfPaymentController } from './proof-of-payment.controller.js';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { OrderLookupController } from './order-lookup.controller.js';
import { OrderLookupService } from './order-lookup.service.js';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here (same pattern CheckoutModule already uses).
//
// Story 5.1: OrderLookupController/-Service added alongside the Story 4.2
// proof-of-payment pair, both sharing the SAME OrderAccessTokenGuard
// instance registered once here.
@Module({
  controllers: [ProofOfPaymentController, OrderLookupController],
  providers: [ProofOfPaymentService, OrderLookupService, OrderAccessTokenGuard],
})
export class OrdersModule {}
