import '../common/env-at-import.js';
import { cronFromEnv } from '../common/cron-expression.js';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { VitrinaScoringService } from './vitrina-scoring.service.js';
import type { RecomputeTrigger } from './vitrina-scoring.service.js';

/**
 * Story 18.8 (AD-84): hourly recompute, bootstrap recompute when there is no
 * ranking yet, and the daily purge of old runs. Same shape as
 * `TcgNightlySyncService`: the handlers only check the flag and call a public,
 * testable method.
 */
@Injectable()
export class VitrinaCronService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VitrinaCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: VitrinaScoringService,
  ) {}

  /**
   * `VITRINA_CRON_ENABLED=false` disables it; default on (off under
   * NODE_ENV=test so the e2e suite never writes rankings by itself).
   */
  isEnabled(): boolean {
    const v = (process.env.VITRINA_CRON_ENABLED ?? '').trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap(): void {
    // Never blocks nor breaks the boot.
    void this.bootstrapCompute();
  }

  /** Computes once if no run is current yet. Never throws. */
  async bootstrapCompute(): Promise<'COMPUTED' | 'SKIPPED' | 'FAILED'> {
    if (!this.isEnabled()) return 'SKIPPED';
    try {
      const rows = await this.prisma.$queryRaw<
        { currentRunId: string | null }[]
      >`
        SELECT "currentRunId" FROM "Vitrina_Algorithm_Settings" WHERE "id" = 'default'`;
      if (rows[0]?.currentRunId) return 'SKIPPED';
      return await this.run('BOOTSTRAP');
    } catch (err) {
      this.logger.error(
        `Vitrina bootstrap check failed (${err instanceof Error ? err.constructor.name : 'error'})`,
      );
      return 'FAILED';
    }
  }

  // NOTE: read when the class is decorated (at import), after `env-at-import` loaded `.env`; invalid = the start
  // stops naming VITRINA_RECOMPUTE_CRON.
  @Cron(cronFromEnv('VITRINA_RECOMPUTE_CRON', '0 * * * *'), {
    name: 'vitrina-recompute',
  })
  async handleCron(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.run('CRON');
  }

  @Cron('30 3 * * *', { name: 'vitrina-runs-purge', timeZone: 'UTC' })
  async handlePurgeCron(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      const n = await this.scoring.pruneRuns();
      this.logger.log(`Product_Score_Runs purge: ${n} run(s) removed`);
    } catch (err) {
      this.logger.error(
        `Product_Score_Runs purge failed (${err instanceof Error ? err.constructor.name : 'error'})`,
      );
    }
  }

  /** Cron entry: an overlapping run exits silently; errors are logged only. */
  async run(
    trigger: RecomputeTrigger,
  ): Promise<'COMPUTED' | 'SKIPPED' | 'FAILED'> {
    try {
      const r = await this.scoring.recompute(trigger);
      if (r.status === 'IN_PROGRESS') return 'SKIPPED';
      this.logger.log(
        `Vitrina recompute (${trigger}): ${r.mode}, ${r.salesCount} unit(s) in window, ${r.durationMs} ms`,
      );
      return 'COMPUTED';
    } catch {
      return 'FAILED'; // already logged by the service
    }
  }
}
