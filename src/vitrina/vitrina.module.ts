import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AdminVitrinaController } from './admin-vitrina.controller.js';
import { AdminVitrinaService } from './admin-vitrina.service.js';
import { ProductSignalsService } from './product-signals.service.js';
import { ProductViewController } from './product-view.controller.js';
import { ViewRateLimitGuard } from './view-rate-limit.guard.js';
import { VitrinaCronService } from './vitrina-cron.service.js';
import { VitrinaDataLoader } from './vitrina-data.loader.js';
import { VitrinaScoringService } from './vitrina-scoring.service.js';
import { VitrinaSelectionService } from './vitrina-selection.service.js';

/**
 * Story 18.7 (AD-82) interest signals + Story 18.8 (AD-84) scoring service,
 * cron and admin. PrismaService is global.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    CatalogModule,
  ],
  controllers: [ProductViewController, AdminVitrinaController],
  providers: [
    ProductSignalsService,
    ViewRateLimitGuard,
    VitrinaDataLoader,
    VitrinaScoringService,
    VitrinaCronService,
    VitrinaSelectionService,
    AdminVitrinaService,
  ],
  exports: [
    ProductSignalsService,
    VitrinaScoringService,
    VitrinaSelectionService,
  ],
})
export class VitrinaModule {}
