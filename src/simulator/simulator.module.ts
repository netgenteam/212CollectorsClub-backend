import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TcgModule } from '../tcg/tcg.module.js';
import { AdminSimulatorController } from './admin-simulator.controller.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { PackGeneratorService } from './pack-generator.service.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { SimulatorController } from './simulator.controller.js';
import { SimulatorSetsService } from './simulator-sets.service.js';
import { ManualSetsController } from './manual/manual-sets.controller.js';
import { ManualSetsService } from './manual/manual-sets.service.js';
import { ManualCardsController } from './manual/manual-cards.controller.js';
import { ManualCardsService } from './manual/manual-cards.service.js';
import { SimulatorImagesController } from './manual/simulator-images.controller.js';
import { SimulatorImagesService } from './manual/simulator-images.service.js';

// PassportModule.register: same reason as AdminLandingModule (AdminAuthGuard
// needs a module-scoped AuthModuleOptions). TcgModule only for TCG_API_CLIENT.
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    TcgModule,
  ],
  controllers: [
    AdminSimulatorController,
    ManualSetsController,
    ManualCardsController,
    SimulatorImagesController,
    SimulatorController,
  ],
  providers: [
    SimulatorConfigService,
    SimulatorSetsService,
    ManualSetsService,
    ManualCardsService,
    SimulatorImagesService,
    SimulatorPoolCache,
    PackGeneratorService,
  ],
  exports: [SimulatorConfigService],
})
export class SimulatorModule {}
