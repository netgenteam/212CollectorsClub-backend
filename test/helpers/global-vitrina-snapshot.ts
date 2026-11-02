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
import { restoreVitrina, snapshotVitrina } from './vitrina-snapshot.js';
import type { VitrinaSnapshot } from './vitrina-snapshot.js';

/**
 * Story 18.8: any e2e that recomputes the ranking writes runs/scores, moves
 * `currentRunId` and prunes older runs (real ones included). Same pattern as
 * `global-daily-stats-snapshot.ts`: snapshot the four Vitrina tables before
 * the suite, restore them exactly after it. The marker file doubles as the
 * abort marker (restored first on the next start, only into the same DB).
 */
const MARKER = resolve(
  process.cwd(),
  'node_modules/.cache/vitrina-snapshot.json',
);

interface Marker {
  db: string;
  snapshot: VitrinaSnapshot;
}

const restore = async (c: pg.Client, s: VitrinaSnapshot): Promise<void> => {
  const exec = async (sql: string, params?: unknown[]) =>
    (await c.query(sql, params)).rows as Record<string, unknown>[];
  await c.query('BEGIN');
  try {
    await restoreVitrina(exec, s);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
};

export default async function setup(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const id = await dbIdentity(client);
    if (existsSync(MARKER)) {
      try {
        const m = JSON.parse(readFileSync(MARKER, 'utf8')) as Marker;
        if (m.db === id) await restore(client, m.snapshot);
      } finally {
        unlinkSync(MARKER);
      }
    }
    const snapshot = await snapshotVitrina(
      async (sql, params) =>
        (await client.query(sql, params)).rows as Record<string, unknown>[],
    );
    const marker: Marker = { db: id, snapshot };
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, JSON.stringify(marker));
    return async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await restore(c, marker.snapshot);
        if (existsSync(MARKER)) unlinkSync(MARKER);
      } finally {
        await c.end();
      }
    };
  } finally {
    await client.end();
  }
}
