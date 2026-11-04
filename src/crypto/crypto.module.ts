import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IdDocCryptoService } from './id-doc-crypto.service.js';

/**
 * Story 20.2 (AD-95). Global: Stories 20.3/20.4/20.6 inject `IdDocCryptoService`
 * without importing this module. `onModuleInit` aborts the boot on bad keys.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: IdDocCryptoService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new IdDocCryptoService(config),
    },
  ],
  exports: [IdDocCryptoService],
})
export class CryptoModule {}
