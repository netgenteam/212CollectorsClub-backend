import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { UsageModule } from '../usage/usage.module.js';
import { VitrinaModule } from '../vitrina/vitrina.module.js';
import { readRetentionConfig } from './retention-config.js';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';
import { RETENTION_CONFIG } from './retention.types.js';

/**
 * Story 20.8 (AD-101). An invalid period stops the start (the factory throws); the job itself is OFF
 * unless `NODE_ENV=production` or `RETENTION_PURGE_ENABLED=true` (see `retention-config.ts`).
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    UsageModule,
    VitrinaModule,
  ],
  controllers: [RetentionController],
  providers: [
    {
      provide: RETENTION_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readRetentionConfig((k) => config.get<string>(k)),
    },
    RetentionService,
  ],
})
export class RetentionModule {}
