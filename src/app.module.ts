import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
