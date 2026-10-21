import { Module } from '@nestjs/common';
import { FakeTcgApiClient } from './fake-tcg-api-client.js';
import { TCG_API_CLIENT } from './tcg-api-client.interface.js';
import { tcgApiClientProvider } from './tcg-api-client.provider.js';

// Story 15.3 (AD-54). Later stories (15.4 ingest, 15.7 nightly) extend it.
@Module({
  providers: [FakeTcgApiClient, tcgApiClientProvider],
  exports: [TCG_API_CLIENT, FakeTcgApiClient],
})
export class TcgModule {}
