import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DolarApiProvider } from './dolar-api.provider.js';
import { FakeFxProvider } from './fake-fx.provider.js';
import { FX_PROVIDER, FxProvider } from './fx-provider.js';

const logger = new Logger('FxProviderFactory');

/** Fake when NODE_ENV=test or FX_PROVIDER=fake; otherwise the real one. */
export const fxProviderProvider: Provider = {
  provide: FX_PROVIDER,
  useFactory: (config: ConfigService, fake: FakeFxProvider): FxProvider => {
    const choice = String(config.get('FX_PROVIDER') ?? '')
      .trim()
      .toLowerCase();
    if (process.env.NODE_ENV === 'test' || choice === 'fake') {
      logger.log('Using FakeFxProvider (no network).');
      return fake;
    }
    const timeout = Number(config.get('FX_PROVIDER_TIMEOUT_MS'));
    return new DolarApiProvider(
      config.get<string>('FX_PROVIDER_BASE_URL') || undefined,
      Number.isInteger(timeout) && timeout > 0 ? timeout : undefined,
    );
  },
  inject: [ConfigService, FakeFxProvider],
};
