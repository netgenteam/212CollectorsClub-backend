import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminFxController } from './admin-fx.controller.js';
import { AdminFxService } from './admin-fx.service.js';
import { FakeFxProvider } from './fake-fx.provider.js';
import { fxProviderProvider } from './fx-provider.factory.js';
import { FX_PROVIDER } from './fx-provider.js';
import { FxPublicController } from './fx-public.controller.js';
import { FxRateService } from './fx-rate.service.js';
import { FxRefreshService } from './fx-refresh.service.js';

// Story 18.1 (AD-79). PrismaModule/ConfigModule are global in the host app.
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [AdminFxController, FxPublicController],
  providers: [
    FakeFxProvider,
    fxProviderProvider,
    FxRefreshService,
    FxRateService,
    AdminFxService,
  ],
  exports: [FX_PROVIDER, FakeFxProvider, FxRefreshService, FxRateService],
})
export class FxModule {}
