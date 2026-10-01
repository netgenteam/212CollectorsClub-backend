import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CartModule } from './cart/cart.module.js';
import { ContactModule } from './contact/contact.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsPaypalModule } from './payments-paypal/payments-paypal.module.js';
import { AdminAuthModule } from './admin-auth/admin-auth.module.js';
import { AdminCatalogModule } from './admin-catalog/admin-catalog.module.js';
import { AdminLandingModule } from './admin-landing/admin-landing.module.js';
import { WishlistModule } from './wishlist/wishlist.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Story 5.2: registers `@nestjs/schedule`'s SchedulerRegistry once,
    // globally — required for the `@Cron` decorators on
    // StockHoldExpiryCronService/PaymentProcessingTimeoutCronService
    // (OrdersModule) to actually register and fire. Root-level `forRoot()`
    // call, per `@nestjs/schedule`'s own setup contract — never imported a
    // second time by any feature module.
    ScheduleModule.forRoot(),
    PrismaModule,
    CatalogModule,
    CartModule,
    ContactModule,
    PaymentsPaypalModule,
    CheckoutModule,
    OrdersModule,
    // Story 7.1: registered once, here — instantiates AdminJwtStrategy
    // exactly once, which is all `AdminAuthGuard` (src/common/, imported
    // directly by every later Epic 8/9/10 module) needs to work anywhere
    // in the app. See AdminAuthGuard's own doc comment for the full
    // reasoning.
    AdminAuthModule,
    // Story 8.1 (AD-2, AD-14): admin CRUD over Category, gated by
    // AdminAuthGuard at the route level — imported directly by its own
    // controller from common/, so this module (like CatalogModule) never
    // needs to import AdminAuthModule itself.
    AdminCatalogModule,
    // Story 10.1 (Epic 10, AD-9, AD-10): the public landing-content GET
    // plus the guarded admin texts/banners PUTs. Same AdminAuthGuard
    // pattern as AdminCatalogModule — never imports AdminAuthModule itself.
    AdminLandingModule,
    // Story 11.5 (FR-36, AD-22): anonymous wishlist via signed cookie.
    WishlistModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
