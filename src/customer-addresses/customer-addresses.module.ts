import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ShippingModule } from '../shipping/shipping.module.js';
import { CustomerAddressesController } from './customer-addresses.controller.js';
import { CustomerAddressesService } from './customer-addresses.service.js';

/** Story 17.2 (AD-72). PassportModule.register: same reason as OrdersModule. */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    ShippingModule,
  ],
  controllers: [CustomerAddressesController],
  providers: [CustomerAddressesService],
})
export class CustomerAddressesModule {}
