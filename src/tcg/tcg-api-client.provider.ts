import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TCG_API_CLIENT, TcgApiClient } from './tcg-api-client.interface.js';
import { TcgApiHttpClient } from './tcg-api-http-client.js';
import { FakeTcgApiClient } from './fake-tcg-api-client.js';

const logger = new Logger('TcgApiClientProvider');

/**
 * Story 15.3 (AD-54): `TCGAPI_KEY` set => real `TcgApiHttpClient`.
 * Unset => `FakeTcgApiClient` (provider `FAKE`) with a warning.
 */
export const tcgApiClientProvider: Provider = {
  provide: TCG_API_CLIENT,
  useFactory: (
    configService: ConfigService,
    fake: FakeTcgApiClient,
  ): TcgApiClient => {
    const apiKey = configService.get<string>('TCGAPI_KEY');
    if (apiKey) {
      logger.log('TCGAPI_KEY configured — using TcgApiHttpClient.');
      return new TcgApiHttpClient(apiKey);
    }
    logger.warn(
      'TCGAPI_KEY not configured — using FakeTcgApiClient (provider FAKE). ' +
        'No real tcgapi.dev call is ever made. Set TCGAPI_KEY to activate ' +
        'the real client.',
    );
    return fake;
  },
  inject: [ConfigService, FakeTcgApiClient],
};
