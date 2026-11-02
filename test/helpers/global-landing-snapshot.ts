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
 * Story 18.12: the legacy landing suites (landing-content from 10.3,
 * landing-*, epic-16 regression, ...) rewrite REAL `Landing_Config_Entries`
 * (`banners/banner2`, `drop212/displayText`, `drop212/targetDate`,
 * `texts/heroTitle`, ...) and the Home is built from them. Same pattern as
 * `global-daily-stats-snapshot.ts`: snapshot the WHOLE table before the
 * suite, restore it exactly after. The marker file doubles as the abort
 * marker: if it exists at startup the previous run died, so it is restored
 * first, and only into the very DB it was taken from (DB identity).
 *
 * Faithfulness: every column travels as text. Json columns are read with
 * `::text` so SQL NULL (JS null) stays distinguishable from a JSON `null`
 * ('null'), and are written back with `::jsonb` — the equivalent of
 * `Prisma.DbNull` for `draftValue`. Timestamps keep their exact precision.
 * References to admins that no longer exist are dropped (FK would reject).
 */
const MARKER = resolve(
  process.cwd(),
  'node_modules/.cache/landing-snapshot.json',
);

interface Row {
  id: string;
  section: string;
  key: string;
  valueType: string;
  value: string;
  updatedAt: string;
  updatedById: string | null;
  draftValue: string | null;
  draftUpdatedAt: string | null;
  draftUpdatedById: string | null;
  publishedAt: string | null;
}
interface Marker {
  db: string;
  rows: Row[];
}

async function snapshot(c: pg.Client): Promise<Row[]> {
  const r = await c.query<Row>(
    `SELECT "id"::text AS id, "section", "key", "valueType",
            "value"::text AS value, "updatedAt"::text AS "updatedAt",
            "updatedById"::text AS "updatedById",
            "draftValue"::text AS "draftValue",
            "draftUpdatedAt"::text AS "draftUpdatedAt",
            "draftUpdatedById"::text AS "draftUpdatedById",
            "publishedAt"::text AS "publishedAt"
     FROM "Landing_Config_Entries" ORDER BY "id"`,
  );
  return r.rows;
}

async function restore(c: pg.Client, rows: Row[]): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query(`DELETE FROM "Landing_Config_Entries"`);
    for (const r of rows) {
      await c.query(
        `INSERT INTO "Landing_Config_Entries"
           ("id","section","key","valueType","value","updatedAt","updatedById",
            "draftValue","draftUpdatedAt","draftUpdatedById","publishedAt")
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::timestamp,
                 (SELECT "id" FROM "Admin_Users" WHERE "id" = $7::uuid),
                 $8::jsonb,$9::timestamptz,
                 (SELECT "id" FROM "Admin_Users" WHERE "id" = $10::uuid),
                 $11::timestamptz)`,
        [
          r.id,
          r.section,
          r.key,
          r.valueType,
          r.value,
          r.updatedAt,
          r.updatedById,
          r.draftValue,
          r.draftUpdatedAt,
          r.draftUpdatedById,
          r.publishedAt,
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
    const marker: Marker = { db: id, rows: await snapshot(client) };
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
