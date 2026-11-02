import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VitrinaDataLoader } from './vitrina-data.loader.js';
import { lockSetting, toScoringConfig } from './vitrina-settings.js';
import { computeRanking } from './vitrina-scoring.js';
import type { VitrinaMode } from './vitrina.types.js';

export type RecomputeTrigger = 'CRON' | 'ADMIN' | 'BOOTSTRAP';

export interface RecomputeRun {
  runId: string;
  computedAt: Date;
  mode: VitrinaMode;
  salesCount: number;
  durationMs: number;
}

export type RecomputeOutcome =
  ({ status: 'OK' } & RecomputeRun) | { status: 'IN_PROGRESS' };

/** Runs kept after a successful recompute (AD-81). */
export const VITRINA_RUNS_KEPT = 3;
/** Interactive tx budget: the default 5 s is too tight for large catalogs. */
export const TX_TIMEOUT_MS = 60_000;

/**
 * Story 18.8 (AD-81, AD-84, FR-99): turns the pure `computeRanking` into
 * persisted runs. Read + compute + write happen in ONE transaction that
 * opens with a transaction-scoped advisory try-lock, so two recomputes never
 * overlap (the loser reports IN_PROGRESS) and a failure rolls everything back,
 * leaving the previous `currentRunId` untouched.
 */
@Injectable()
export class VitrinaScoringService {
  private readonly logger = new Logger(VitrinaScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: VitrinaDataLoader,
  ) {}

  /**
   * Seam between "scores inserted" and "pointer swapped"; the e2e overrides it
   * to force a mid-transaction failure / hold the lock. No-op in production.
   */
  protected async beforePointerSwap(): Promise<void> {
    await Promise.resolve();
  }

  async recompute(
    trigger: RecomputeTrigger,
    now: Date = new Date(),
  ): Promise<RecomputeOutcome> {
    const started = Date.now();
    try {
      return await this.prisma.$transaction(
        async (tx): Promise<RecomputeOutcome> => {
          const lock = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended('vitrina:recompute', 0)) AS locked`;
          if (!lock[0]?.locked) return { status: 'IN_PROGRESS' };

          // Locking the settings row also serializes against `PUT algorithm`,
          // so the config copied into the run is the one actually applied.
          const setting = await lockSetting(tx);
          const config = toScoringConfig(setting);
          const data = await this.loader.load(tx, config.windowDays, now);
          const result = computeRanking({
            products: data.products,
            events: data.events,
            config,
            now,
          });
          const durationMs = Date.now() - started;

          const run = await tx.productScoreRun.create({
            data: {
              mode: result.mode,
              config: config as unknown as Prisma.InputJsonObject,
              salesCount: result.salesCount,
              durationMs,
            },
          });
          if (result.ranked.length > 0) {
            await tx.productScore.createMany({
              data: result.ranked.map((r) => ({
                runId: run.id,
                productId: r.id,
                rank: r.rank,
                score: new Prisma.Decimal(r.score.toFixed(4)),
                components: r.components as unknown as Prisma.InputJsonObject,
                reason: r.reason,
              })),
            });
          }
          await this.beforePointerSwap();
          await tx.$executeRaw`
            UPDATE "Vitrina_Algorithm_Settings"
            SET "currentRunId" = ${run.id}::uuid
            WHERE "id" = 'default'`;
          await this.pruneRuns(tx);
          return {
            status: 'OK',
            runId: run.id,
            computedAt: run.computedAt,
            mode: result.mode,
            salesCount: result.salesCount,
            durationMs,
          };
        },
        { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
      );
    } catch (err) {
      // Only the error class: messages may echo SQL parameters.
      this.logger.error(
        `Vitrina recompute (${trigger}) failed and was rolled back (${
          err instanceof Error ? err.constructor.name : 'error'
        }); previous ranking stays current.`,
      );
      throw err;
    }
  }

  /**
   * Deletes every run except the newest `VITRINA_RUNS_KEPT` and the current
   * one (scores go with them via ON DELETE CASCADE). Idempotent.
   */
  async pruneRuns(
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    return db.$executeRaw`
      DELETE FROM "Product_Score_Runs"
      WHERE "id" NOT IN (
        SELECT "id" FROM "Product_Score_Runs"
        ORDER BY "computedAt" DESC, "id" DESC
        LIMIT ${VITRINA_RUNS_KEPT}::int)
      AND "id" IS DISTINCT FROM (
        SELECT "currentRunId" FROM "Vitrina_Algorithm_Settings" WHERE "id" = 'default')`;
  }
}
