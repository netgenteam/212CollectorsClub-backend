import 'dotenv/config';
import pg from 'pg';

/**
 * Story 18.3 (AD-80): checkout now answers 503 when the FX rate is older than
 * maxAgeHours x 3, and the real local row can be weeks old. For the duration
 * of the e2e run its `rateFetchedAt` is set to now(), and the original value
 * is put back afterwards (nothing else in the row is touched). Suites that
 * need a stale/absent rate set it up themselves and restore it.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const before = await client.query<{ rateFetchedAt: Date | null }>(
    `SELECT "rateFetchedAt" FROM "Fx_Rate_Settings" WHERE "id" = 'default'`,
  );
  const had = before.rows.length === 1;
  const original = had ? before.rows[0].rateFetchedAt : null;
  if (had) {
    await client.query(
      `UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = now() WHERE "id" = 'default'`,
    );
  }
  await client.end();
  return async () => {
    if (!had) return;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query(
      `UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = $1 WHERE "id" = 'default'`,
      [original],
    );
    await c.end();
  };
}
