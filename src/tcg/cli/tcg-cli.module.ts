import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { TcgModule } from '../tcg.module.js';

/**
 * Story 15.4 (AD-55): minimal module of the `pnpm tcg:ingest` CLI. No
 * `ScheduleModule`, no HTTP: only config + Prisma + the TCG module.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, TcgModule],
})
export class TcgCliModule {}
