import { Module } from '@nestjs/common';
import { ProofOfPaymentController } from './proof-of-payment.controller.js';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here (same pattern CheckoutModule already uses).
@Module({
  controllers: [ProofOfPaymentController],
  providers: [ProofOfPaymentService, OrderAccessTokenGuard],
})
export class OrdersModule {}
