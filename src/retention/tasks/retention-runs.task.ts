import { marginalClock } from '../retention-clock.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `retention_runs`: the job's own history (`Retention_Runs`, a table of operation, A105: it admits
 * UPDATE and DELETE; the immutable record of every run is `RETENTION_PURGE_RUN` in `Audit_Events`).
 * Without this the table would grow by one row a day for ever.
 *
 * What it must never delete (each one is a condition of the statement):
 *  - a `RUNNING` row (a live run, or a dead one the next run has not reconciled yet);
 *  - a row of a run that has not finished (`finishedAt IS NULL`);
 *  - the row of the CURRENT run (`id <> runId`): it is the anchor of the clock of the next run
 *    (`effectiveNow`), and the newest row always is newer than the cut-off in any case.
 * Only rows older than `PURGE_RETENTION_RUNS_DAYS` (default 400, 90..3650) go. Rows hold counters and
 * the id of the admin who started a manual run; nothing else.
 */
export const retentionRunsTask: RetentionTask = {
  name: 'retention_runs',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const days = ctx.cfg.retentionRunsDays;
    const runId = ctx.runId;
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Retention_Runs"
           WHERE "status" <> 'RUNNING' AND "finishedAt" IS NOT NULL AND "id" <> ${runId}::uuid
             AND "startedAt" < ((${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)) AT TIME ZONE 'UTC'
           ORDER BY "startedAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Retention_Runs" r USING picked WHERE r."id" = picked."id"`,
    );
  },
};
