import { Module } from '@nestjs/common';
import { FakeTcgApiClient } from './fake-tcg-api-client.js';
import { MasterCardUpsertService } from './master-card-upsert.service.js';
import { TCG_API_CLIENT } from './tcg-api-client.interface.js';
import { tcgApiClientProvider } from './tcg-api-client.provider.js';
import { TcgIngestService } from './tcg-ingest.service.js';
import { TcgNightlySyncService } from './tcg-nightly-sync.service.js';
import { TcgSyncRunService } from './tcg-sync-run.service.js';

// Story 15.3 (AD-54) client + Story 15.4 (AD-55/58) ingestion. 15.7 (AD-58) nightly sync. PrismaModule/ConfigModule are global in the hosting app.
@Module({
  providers: [
    FakeTcgApiClient,
    tcgApiClientProvider,
    MasterCardUpsertService,
    TcgSyncRunService,
    TcgIngestService,
    TcgNightlySyncService,
  ],
  exports: [
    TCG_API_CLIENT,
    FakeTcgApiClient,
    MasterCardUpsertService,
    TcgSyncRunService,
    TcgIngestService,
    TcgNightlySyncService,
  ],
})
export class TcgModule {}
