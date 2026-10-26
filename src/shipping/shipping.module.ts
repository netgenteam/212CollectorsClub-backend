import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminShippingController } from './admin-shipping.controller.js';
import { ShippingAgenciesService } from './shipping-agencies.service.js';
import { ShippingController } from './shipping.controller.js';

/**
 * Story 17.1 (Epic 17, AD-71). PassportModule.register: same reason as
 * SimulatorModule (AdminAuthGuard needs a module-scoped AuthModuleOptions).
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [ShippingController, AdminShippingController],
  providers: [ShippingAgenciesService],
  exports: [ShippingAgenciesService],
})
export class ShippingModule {}
