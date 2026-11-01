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
import { dbIdentity } from './db-identity.js';

/**
 * Story 18.7: the cart hook (`recordCartAdd`) makes every pre-existing e2e
 * that calls `addItem` write today's `cartAdds` onto real seed products.
 * This globalSetup snapshots the WHOLE `Product_Daily_Stats` table at the
 * start of the suite and restores it exactly at the end (all rows deleted,
 * snapshot rows re-inserted; rows whose product no longer exists are skipped
 * since the FK would reject them).
 *
 * Storage choice: a JSON file under node_modules/.cache instead of a table in
 * the DB. A side table would pollute the schema (migrate drift) and a TEMP
 * table dies with its connection; the file doubles as the abort marker: if
 * it exists at startup, the previous run died, so it is restored first.
 * The marker stores a DB identity (hash of DATABASE_URL + current_database())
 * and is only restored into that same database; otherwise it is discarded.
 */
const MARKER = resolve(
  process.cwd(),
  'node_modules/.cache/daily-stats-snapshot.json',
);

interface Row {
  productId: string;
  day: string;
  views: number;
  cartAdds: number;
}
interface Marker {
  db: string;
  rows: Row[];
}

async function restore(c: pg.Client, rows: Row[]): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query(`DELETE FROM "Product_Daily_Stats"`);
    if (rows.length > 0) {
      await c.query(
        `INSERT INTO "Product_Daily_Stats" ("productId","day","views","cartAdds")
         SELECT s."productId", s."day", s."views", s."cartAdds"
         FROM unnest($1::uuid[], $2::date[], $3::int[], $4::int[])
           AS s("productId","day","views","cartAdds")
         WHERE EXISTS (SELECT 1 FROM "Products" p WHERE p."id" = s."productId")`,
        [
          rows.map((r) => r.productId),
          rows.map((r) => r.day),
          rows.map((r) => r.views),
          rows.map((r) => r.cartAdds),
        ],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const id = await dbIdentity(client);
    if (existsSync(MARKER)) {
      try {
        const m = JSON.parse(readFileSync(MARKER, 'utf8')) as Marker;
        if (m.db === id) await restore(client, m.rows);
      } finally {
        unlinkSync(MARKER);
      }
    }
    const res = await client.query<{
      productId: string;
      day: string;
      views: number;
      cartAdds: number;
    }>(
      `SELECT "productId", to_char("day",'YYYY-MM-DD') AS day, "views", "cartAdds"
       FROM "Product_Daily_Stats"`,
    );
    const marker: Marker = { db: id, rows: res.rows };
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, JSON.stringify(marker));
    return async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await restore(c, marker.rows);
        if (existsSync(MARKER)) unlinkSync(MARKER);
      } finally {
        await c.end();
      }
    };
  } finally {
    await client.end();
  }
}
