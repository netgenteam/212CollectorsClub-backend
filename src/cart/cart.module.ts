import { Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartCookieService } from './cart-cookie.service.js';
import { CartService } from './cart.service.js';

// PrismaService is provided by the global PrismaModule (see
// src/prisma/prisma.module.ts) — no need to re-import it here.
//
// CartCookieService is exported (Story 4.1) so CheckoutModule can reuse the
// exact same AD-5 cart-cookie read/write/clear logic instead of a second
// copy — CheckoutController reads the cartId cookie the same way
// CartController does, and clears it after a successful checkout.
@Module({
  controllers: [CartController],
  providers: [CartService, CartCookieService],
  exports: [CartCookieService],
})
export class CartModule {}
