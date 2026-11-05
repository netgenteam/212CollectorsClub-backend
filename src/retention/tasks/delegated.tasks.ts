import type { UsageLogPurgeService } from '../../usage/usage-purge.service.js';
import type { ProductSignalsService } from '../../vitrina/product-signals.service.js';
import { marginalClock } from '../retention-clock.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `usage_logs` (FR-131, FR-134): the 7-day purge of `Usage_Logs` is Story 20.7's `UsageLogPurgeService`;
 * this task INVOKES it (with the run's clock, batch size, pause and stop condition), it does not
 * reimplement it. It deletes only (`DELETE` by `id` in batches; never `UPDATE`, never
 * `FOR UPDATE SKIP LOCKED`: the application role has no `UPDATE` on that table).
 */
export const usageLogsTask = (purge: UsageLogPurgeService): RetentionTask => ({
  name: 'usage_logs',
  async run(ctx) {
    const r = await purge.purgeExpired({
      days: ctx.cfg.usageLogDays,
      batch: ctx.cfg.batchSize,
      pauseMs: ctx.cfg.batchPauseMs,
      // the run's own deadline (`shouldStop`) is the budget; this is only the service's internal cap
      maxRunMs: ctx.cfg.maxRunMs,
      asOf: marginalClock(ctx.asOf),
      shouldStop: ctx.shouldStop,
    });
    return { rows: r.rows, truncated: r.truncated };
  },
});

/**
 * `product_daily_stats` (FR-131): INVOKES the 180-day purge of Epic 18 (`ProductSignalsService`), the
 * only code that deletes that table; it is not copied here. It keeps its own daily cron at 03:30; both are
 * idempotent, so running twice only means the second finds nothing.
 */
export const productDailyStatsTask = (
  signals: ProductSignalsService,
): RetentionTask => ({
  name: 'product_daily_stats',
  async run(ctx) {
    return signals.purgeOldStatsBounded(
      marginalClock(ctx.asOf),
      ctx.cfg.batchSize,
      { shouldStop: ctx.shouldStop, pauseMs: ctx.cfg.batchPauseMs },
    );
  },
});
