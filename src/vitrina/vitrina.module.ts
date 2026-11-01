import { Module } from '@nestjs/common';
import { ProductSignalsService } from './product-signals.service.js';
import { ProductViewController } from './product-view.controller.js';
import { ViewRateLimitGuard } from './view-rate-limit.guard.js';

/** Story 18.7 (AD-82): interest signals (views, cartAdds). PrismaService is global. */
@Module({
  controllers: [ProductViewController],
  providers: [ProductSignalsService, ViewRateLimitGuard],
  exports: [ProductSignalsService],
})
export class VitrinaModule {}
