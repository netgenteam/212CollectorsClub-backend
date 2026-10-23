import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TcgModule } from '../tcg/tcg.module.js';
import { AdminSimulatorController } from './admin-simulator.controller.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { PackGeneratorService } from './pack-generator.service.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { SimulatorController } from './simulator.controller.js';
import { SimulatorSetsService } from './simulator-sets.service.js';

// PassportModule.register: same reason as AdminLandingModule (AdminAuthGuard
// needs a module-scoped AuthModuleOptions). TcgModule only for TCG_API_CLIENT.
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    TcgModule,
  ],
  controllers: [AdminSimulatorController, SimulatorController],
  providers: [
    SimulatorConfigService,
    SimulatorSetsService,
    SimulatorPoolCache,
    PackGeneratorService,
  ],
  exports: [SimulatorConfigService],
})
export class SimulatorModule {}
