import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here. CartModule is imported (not re-implemented) so
// CheckoutController reuses the exact same AD-5 cart-cookie logic
// CartController already uses, per CartModule's own exports doc comment.
@Module({
  imports: [CartModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
})
export class CheckoutModule {}
