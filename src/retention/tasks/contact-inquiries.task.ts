import { marginalClock } from '../retention-clock.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `contact_inquiries` (FR-131): `Contact_Inquiries` created more than `PURGE_CONTACT_MONTHS` (default 12,
 * 3..60) ago, counted in calendar months. Closing an account does NOT delete them (Story 20.6): this
 * is the only thing that does. The calendar-month subtraction is done on the UTC wall clock
 * (`asOf AT TIME ZONE 'UTC'` first), never on a `timestamptz` in the session's zone: there it would follow the
 * calendar and the DST of that zone (checked against UTC, America/Caracas, America/New_York and Asia/Tokyo).
 * Nothing points at the table (its own FK to `Products` is SET NULL in the
 * other direction).
 */
export const contactInquiriesTask: RetentionTask = {
  name: 'contact_inquiries',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const months = ctx.cfg.contactMonths;
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Contact_Inquiries"
           WHERE "createdAt" < ((${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(months => ${months}::int))
           ORDER BY "createdAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Contact_Inquiries" c USING picked WHERE c."id" = picked."id"`,
    );
  },
};
