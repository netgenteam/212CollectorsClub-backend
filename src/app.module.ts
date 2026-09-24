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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
