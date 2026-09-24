import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { PaymentsPaypalModule } from '../payments-paypal/payments-paypal.module.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here. CartModule is imported (not re-implemented) so
// CheckoutController reuses the exact same AD-5 cart-cookie logic
// CartController already uses, per CartModule's own exports doc comment.
// PaymentsPaypalModule (Story 4.3) is imported so CheckoutService can
// inject the currently-active PAYPAL_CLIENT for its paypal branch's
// createOrder call — the module that OWNS the PayPal integration and the
// webhook/confirmation side is `payments-paypal`, never duplicated here.
@Module({
  imports: [CartModule, PaymentsPaypalModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
})
export class CheckoutModule {}
