import 'dotenv/config';
import pg from 'pg';

/**
 * Story 19.4: `Consent_Records` is append-only. A registration (e2e creates
 * dozens of customers) leaves an AGE_DECLARATION row that is only ever
 * deletable once its customer is gone (the FK `SetNull` cascade orphans it;
 * the trigger allows deleting only orphans). So the suite removes, after the
 * run, exactly the orphan rows that did NOT exist before it started: orphans
 * that were already there (evidence of accounts removed earlier by someone
 * else) are left alone.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let before: string[];
  try {
    const r = await client.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "Consent_Records"
       WHERE "customerId" IS NULL AND "orderId" IS NULL`,
    );
    before = r.rows.map((x) => x.id);
  } finally {
    await client.end();
  }
  return async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query(
        `DELETE FROM "Consent_Records"
         WHERE "customerId" IS NULL AND "orderId" IS NULL
           AND "id" <> ALL($1::uuid[])`,
        [before],
      );
    } finally {
      await c.end();
    }
  };
}
