import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isLockWaitExpired } from '../common/lock-timeout.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UsageLogConfig } from './usage-config.js';
import { USAGE_LOG_CONFIG } from './usage-log.types.js';

export interface UsagePurgeResult {
  rows: number;
  batches: number;
  durationMs: number;
  truncated: boolean;
}

/** One batch of the purge; with a 100 ms pause 1 M rows take about 2.5 minutes (NFR-20.3: under 5). */
export const PURGE_BATCH = 1_000;
export const PURGE_PAUSE_MS = 100;
export const PURGE_MAX_RUN_MS = 5 * 60_000;

/** Distinct from the audit chain lock (2120001) and from Story 20.8's retention run lock (2120002). */
export const PURGE_ADVISORY_KEY = 2120003;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Story 20.7 (the purge is Story 20.8's, FR-131, but an unbounded table between the two stories is
 * not acceptable): deletes `Usage_Logs` older than `PURGE_USAGE_LOG_DAYS` (default 7, 1..7: the Privacy Policy promises 7) every day.
 *
 *   - batches of 1 000 by `ts` (`DELETE ... WHERE id IN (SELECT id ... ORDER BY ts LIMIT n)`): each batch is
 *     its own short transaction, so no lock is held long and the writer (an INSERT) never waits for it. No
 *     `FOR UPDATE SKIP LOCKED`: it needs the UPDATE privilege, which the application role does not have on
 *     this table (found by running the whole e2e suite under the limited role). A batch that meets a row
 *     the anonymization is deleting at that moment waits at most 2 s and then ends the run (`truncated`);
 *   - a pause between batches, a cap of 5 minutes per run (`truncated`: the rest goes in the next run);
 *   - a transaction-level advisory lock per batch, so two instances never purge at the same time;
 *   - idempotent: running it twice leaves the same table.
 *
 * Story 20.8: `RetentionService` calls `purgeExpired()` as its `usage_logs` task (with the run's clock and
 * stop condition) and is the ONLY schedule: this service has no cron of its own any more (round 2). The old
 * `USAGE_LOG_PURGE_CRON` left two holes: with the job active and `RETENTION_PURGE_CRON=off` nobody purged, and
 * with the job disabled the old cron purged without the safety margin or the capped clock.
 */
@Injectable()
export class UsageLogPurgeService implements OnModuleInit {
  private readonly logger = new Logger(UsageLogPurgeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(USAGE_LOG_CONFIG) private readonly cfg: UsageLogConfig,
    private readonly config: ConfigService,
  ) {}

  /** `USAGE_LOG_PURGE_CRON` no longer exists: say so instead of leaving someone to believe it still schedules. */
  onModuleInit(): void {
    const legacy = String(
      this.config.get<string>('USAGE_LOG_PURGE_CRON') ?? '',
    ).trim();
    if (legacy !== '' && legacy.toLowerCase() !== 'off') {
      this.logger.warn(
        'USAGE_LOG_PURGE_CRON is IGNORED: the usage log is purged only by the retention job (RETENTION_PURGE_CRON, RETENTION_PURGE_ENABLED); remove the variable',
      );
    }
  }

  async purgeExpired(
    opts: {
      days?: number;
      batch?: number;
      pauseMs?: number;
      maxRunMs?: number;
      /** Story 20.8: the instant the period is counted back from (default: the database's `now()`). */
      asOf?: Date;
      /** Story 20.8: asked before every batch; true ends the purge `truncated`. */
      shouldStop?: () => boolean;
    } = {},
  ): Promise<UsagePurgeResult> {
    const days = opts.days ?? this.cfg.purgeDays;
    const batch = opts.batch ?? PURGE_BATCH;
    const pause = opts.pauseMs ?? PURGE_PAUSE_MS;
    const maxRun = opts.maxRunMs ?? PURGE_MAX_RUN_MS;
    // A parameter, never string-built; null = the database clock (the 20.7 behaviour).
    const asOfIso = opts.asOf ? opts.asOf.toISOString() : null;
    if (this.running)
      return { rows: 0, batches: 0, durationMs: 0, truncated: false };
    this.running = true;
    const t0 = Date.now();
    let rows = 0;
    let batches = 0;
    try {
      for (;;) {
        if (Date.now() - t0 > maxRun || opts.shouldStop?.()) {
          return {
            rows,
            batches,
            durationMs: Date.now() - t0,
            truncated: true,
          };
        }
        let deleted: number;
        try {
          deleted = await this.prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '20000ms', true)`;
              const got = await tx.$queryRaw<
                { ok: boolean }[]
              >`SELECT pg_try_advisory_xact_lock(${PURGE_ADVISORY_KEY}::int) AS ok`;
              if (!got[0]?.ok) return -1;
              // Story 20.7 round 2: the cut-off is computed on the UTC wall clock and converted back, never
              // as `timestamptz - interval 'N days'`: that subtraction runs in the SESSION's TimeZone, and across a
              // DST change `7 days` is 167 or 169 hours (rows were purged up to an hour early, or kept an hour late).
              // No `FOR UPDATE SKIP LOCKED`: a row-locking clause needs the UPDATE privilege, which the
              // application role does not have on this table. The DELETE takes its own row locks.
              return tx.$executeRaw`
                DELETE FROM "Usage_Logs"
                 WHERE "id" IN (SELECT "id" FROM "Usage_Logs"
                                 WHERE "ts" < ((coalesce(${asOfIso}::timestamptz, now()) AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)) AT TIME ZONE 'UTC'
                                 ORDER BY "ts" LIMIT ${batch}::int)`;
            },
            { maxWait: 2_000, timeout: 30_000 },
          );
        } catch (err) {
          // A row of the batch is locked by the delete of an anonymization that has not committed: that
          // account's rows are being removed anyway. Stop here; the next run takes the rest.
          if (isLockWaitExpired(err)) {
            return {
              rows,
              batches,
              durationMs: Date.now() - t0,
              truncated: true,
            };
          }
          throw err;
        }
        if (deleted < 0) {
          // another instance is purging
          return {
            rows,
            batches,
            durationMs: Date.now() - t0,
            truncated: false,
          };
        }
        rows += deleted;
        batches += 1;
        if (deleted < batch) break;
        await sleep(pause);
      }
      return { rows, batches, durationMs: Date.now() - t0, truncated: false };
    } finally {
      this.running = false;
    }
  }
}
