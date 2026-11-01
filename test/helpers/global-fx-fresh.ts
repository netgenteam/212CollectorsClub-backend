import 'dotenv/config';
import pg from 'pg';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Survives an aborted run: the original value is restored on the next one. */
const MARKER = resolve(
  process.cwd(),
  'node_modules/.cache/fx-fresh-marker.json',
);

async function restore(value: string | null): Promise<void> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(
    `UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = $1 WHERE "id" = 'default'`,
    [value],
  );
  await c.end();
}

/**
 * Story 18.3 (AD-80): checkout now answers 503 when the FX rate is older than
 * maxAgeHours x 3, and the real local row can be weeks old. For the duration
 * of the e2e run its `rateFetchedAt` is set to now(), and the original value
 * is put back afterwards (nothing else in the row is touched). Suites that
 * need a stale/absent rate set it up themselves and restore it.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (existsSync(MARKER)) {
    // A previous run died before teardown: put its original value back first.
    try {
      const m = JSON.parse(readFileSync(MARKER, 'utf8')) as {
        original: string | null;
      };
      await restore(m.original);
    } finally {
      unlinkSync(MARKER);
    }
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const before = await client.query<{ rateFetchedAt: Date | null }>(
    `SELECT "rateFetchedAt" FROM "Fx_Rate_Settings" WHERE "id" = 'default'`,
  );
  const had = before.rows.length === 1;
  const original = had ? before.rows[0].rateFetchedAt : null;
  if (had) {
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(
      MARKER,
      JSON.stringify({ original: original ? original.toISOString() : null }),
    );
    await client.query(
      `UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = now() WHERE "id" = 'default'`,
    );
  }
  await client.end();
  return async () => {
    if (!had) return;
    await restore(original ? original.toISOString() : null);
    if (existsSync(MARKER)) unlinkSync(MARKER);
  };
}
