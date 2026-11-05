import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { readUsageLogConfig } from './usage-config.js';
import { UsageAdminController } from './usage-admin.controller.js';
import { UsageLogErasure } from './usage-erasure.service.js';
import { UsageLogBuffer } from './usage-log.buffer.js';
import { PrismaUsageLogWriter } from './usage-log.writer.js';
import { USAGE_LOG_CONFIG, USAGE_LOG_WRITER } from './usage-log.types.js';
import { UsageLogPurgeService } from './usage-purge.service.js';
import { UsageReadService } from './usage-read.service.js';

/**
 * Story 20.7 (FR-133..135, AD-100). Global so the anonymization (`UsageLogErasure`) and `main.ts`
 * (`UsageLogBuffer`) can use it without importing it. The middleware itself is mounted in `main.ts`.
 */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [UsageAdminController],
  providers: [
    {
      provide: USAGE_LOG_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readUsageLogConfig((k) => config.get<string>(k)),
    },
    { provide: USAGE_LOG_WRITER, useClass: PrismaUsageLogWriter },
    UsageLogBuffer,
    UsageReadService,
    UsageLogErasure,
    UsageLogPurgeService,
  ],
  exports: [
    UsageLogBuffer,
    UsageLogErasure,
    UsageLogPurgeService,
    USAGE_LOG_CONFIG,
  ],
})
export class UsageModule {}
