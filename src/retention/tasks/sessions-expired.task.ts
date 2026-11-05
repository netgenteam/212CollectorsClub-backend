import { EXPIRED_SESSION_GRACE_DAYS } from '../retention-config.js';
import { marginalClock } from '../retention-clock.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `sessions_expired` (FR-131): `Customer_Sessions` and `Admin_Sessions` whose `expiresAt` passed more
 * than 7 days ago (`EXPIRED_SESSION_GRACE_DAYS`, a constant: the Privacy Policy promises exactly that).
 * Nothing references a session row (no foreign key points at either table), so nothing cascades.
 * The columns are `timestamp without time zone` holding UTC: the cut-off is converted with
 * `AT TIME ZONE 'UTC'`, not compared against `now()` whose zone is the session's.
 *
 * Each batch picks its rows with `FOR UPDATE SKIP LOCKED`: a row somebody else holds (the anonymization
 * of that account deletes its sessions in its own transaction) is skipped, never waited for, so this
 * task cannot queue behind it or deadlock with it; the row goes in the next run.
 */
export const sessionsExpiredTask: RetentionTask = {
  name: 'sessions_expired',
  async run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const days = EXPIRED_SESSION_GRACE_DAYS;
    const customer = await runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Customer_Sessions"
           WHERE "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Customer_Sessions" s USING picked WHERE s."id" = picked."id"`,
    );
    const admin = await runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Admin_Sessions"
           WHERE "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Admin_Sessions" s USING picked WHERE s."id" = picked."id"`,
    );
    return {
      rows: customer.rows + admin.rows,
      truncated: customer.truncated || admin.truncated,
    };
  },
};
