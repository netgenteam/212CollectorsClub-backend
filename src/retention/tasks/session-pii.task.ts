import { marginalClock } from '../retention-config.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `session_pii` (FR-131): `ipAddress` and `userAgent` of a session become NULL when the session was
 * created more than `PURGE_SESSION_PII_DAYS` (default 90, 30..90) ago. A LIVE session is never touched
 * (`expiresAt` already past): the Privacy Policy says exactly that. The row, its token and its dates
 * stay; `updatedAt` is not bumped (the raw UPDATE does not run Prisma's `@updatedAt`).
 *
 * A session lives 7 days (customer, sliding) or 8 hours (admin) and is deleted a week after expiring
 * (`sessions_expired`, which runs first), so this task only ever finds a session that outlived its
 * normal life (a long sliding session that expired in the last week, or a delayed sweep).
 * It is idempotent: the filter excludes rows already nulled. Rows held by another transaction are
 * skipped (`FOR UPDATE SKIP LOCKED`), never waited for.
 */
export const sessionPiiTask: RetentionTask = {
  name: 'session_pii',
  async run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const days = ctx.cfg.sessionPiiDays;
    const customer = await runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Customer_Sessions"
           WHERE "createdAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
             AND "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC')
             AND ("ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        UPDATE "Customer_Sessions" s SET "ipAddress" = NULL, "userAgent" = NULL
          FROM picked WHERE s."id" = picked."id"`,
    );
    const admin = await runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Admin_Sessions"
           WHERE "createdAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
             AND "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC')
             AND ("ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        UPDATE "Admin_Sessions" s SET "ipAddress" = NULL, "userAgent" = NULL
          FROM picked WHERE s."id" = picked."id"`,
    );
    return {
      rows: customer.rows + admin.rows,
      truncated: customer.truncated || admin.truncated,
    };
  },
};
