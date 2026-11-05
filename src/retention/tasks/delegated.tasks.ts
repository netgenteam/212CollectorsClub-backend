import type { UsageLogPurgeService } from '../../usage/usage-purge.service.js';
import type { ProductSignalsService } from '../../vitrina/product-signals.service.js';
import { marginalClock } from '../retention-clock.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `usage_logs` (FR-131, FR-134): the 7-day purge of `Usage_Logs` is Story 20.7's `UsageLogPurgeService`;
 * this task INVOKES it (with the run's clock, batch size, pause and stop condition), it does not
 * reimplement it. It deletes only (`DELETE` by `id` in batches; never `UPDATE`, never
 * `FOR UPDATE SKIP LOCKED`: the application role has no `UPDATE` on that table).
 *
 * CLOCK (decision of Angel, round 3): this task and ONLY this one cuts with the database clock (`ctx.dbNow`),
 * not with the capped `ctx.asOf` that the contact, session and cart tasks use. Reason: the Privacy Policy promises
 * 7 days for the IP and user agent of every visitor, so after an outage the log must not stay past 7 days
 * (with the cap, a 5-day outage left logs of 8 and 9 days alive for days). The price is accepted and written down:
 * after a REAL forward jump of the clock (NTP step, a VM restored from a snapshot, WSL2 waking up) a log of, say,
 * 5 days can be deleted early. That is a far smaller harm (a diagnostic log) than keeping personal data past the
 * promise. The only guard is the run-level one: a real `CLOCK_SKEW` between the database and the application
 * (> 5 min) aborts the whole run before any task (`RetentionService.execute`). The 1-hour safety margin still applies.
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
      asOf: marginalClock(ctx.dbNow),
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
