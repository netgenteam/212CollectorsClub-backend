import { Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartCookieService } from './cart-cookie.service.js';
import { CartService } from './cart.service.js';

// PrismaService is provided by the global PrismaModule (see
// src/prisma/prisma.module.ts) — no need to re-import it here.
@Module({
  controllers: [CartController],
  providers: [CartService, CartCookieService],
})
export class CartModule {}
