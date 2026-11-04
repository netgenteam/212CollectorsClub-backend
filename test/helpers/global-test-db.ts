import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { AuditChainVerifier } from '../../src/audit/audit-chain-verifier.js';
import {
  E2E_DB_RE,
  assertThrowawayUrl,
  dbNameOf,
  isThrowawayDbName,
  withDbName,
} from './test-db.js';

/**
 * Story 20.5: runs FIRST (torn down LAST; vitest tears down in reverse order).
 * See `test-db.ts` for why. Steps:
 *  1. Drop stale `<base>_e2e_*` databases of killed runs (older than 3 hours; only names
 *     of EXACTLY this format, never the source database).
 *  2. `CREATE DATABASE <clone> TEMPLATE <source>`. The source is `E2E_DB_SOURCE` (a quiet
 *     template the developer keeps) or the database of `DATABASE_URL`. Postgres only
 *     clones a database nobody else is connected to: it retries for ~60 s and then
 *     aborts telling the developer to stop the dev server (no session is killed).
 *  3. Point `DATABASE_URL` (and `MIGRATE_DATABASE_URL` if set) of the run at the clone
 *     BEFORE the workers are forked, and verify with `current_database()` that the
 *     run really is on a throw-away database (abort otherwise).
 *  4. Teardown: `DROP DATABASE ... WITH (FORCE)` of this run's clone only.
 * The role that clones needs CREATEDB (the owner / `MIGRATE_DATABASE_URL`).
 */
const STALE_SECONDS = 3 * 3600;
const CLONE_ATTEMPTS = 40;
const CLONE_WAIT_MS = 1_500;

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withAdmin<T>(
  adminUrl: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  // The maintenance database: never the one being cloned or dropped.
  const c = new pg.Client({
    connectionString: withDbName(adminUrl, 'postgres'),
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error('DATABASE_URL is not set');
  const migrateUrl = process.env.MIGRATE_DATABASE_URL || undefined;
  const adminUrl = migrateUrl ?? appUrl;
  const sourceName = process.env.E2E_DB_SOURCE || dbNameOf(appUrl);
  if (isThrowawayDbName(sourceName)) {
    throw new Error(
      `The e2e source database "${sourceName}" is itself a throw-away clone; refusing.`,
    );
  }
  const base = sourceName.slice(0, 30);
  const clone = `${base}_e2e_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString('hex')}`;

  await withAdmin(adminUrl, async (c) => {
    // 1. Stale clones of killed runs.
    const now = Math.floor(Date.now() / 1000);
    const r = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${base.replace(/[\\_%]/g, '\\$&')}\\_e2e\\_%`],
    );
    for (const { datname } of r.rows) {
      const m = E2E_DB_RE.exec(datname);
      if (!m || m[1] !== base || now - Number(m[2]) <= STALE_SECONDS) continue;
      await c.query(`DROP DATABASE IF EXISTS ${q(datname)} WITH (FORCE)`);
    }
    // 2. Clone (retry while someone else is connected to the template).
    let last: unknown;
    for (let i = 0; i < CLONE_ATTEMPTS; i++) {
      try {
        await c.query(`CREATE DATABASE ${q(clone)} TEMPLATE ${q(sourceName)}`);
        return;
      } catch (e) {
        last = e;
        if ((e as { code?: string }).code !== '55006') break; // not "being accessed"
        await sleep(CLONE_WAIT_MS);
      }
    }
    throw new Error(
      `Could not clone "${sourceName}" into "${clone}": ${String(last)}. ` +
        `If other sessions are connected to it (a running dev server?) stop them, or set ` +
        `E2E_DB_SOURCE to a quiet database to clone from. The real database was not touched.`,
    );
  });

  // 3. Redirect the whole run and check it.
  const cloneApp = withDbName(appUrl, clone);
  process.env.DATABASE_URL = cloneApp;
  if (migrateUrl)
    process.env.MIGRATE_DATABASE_URL = withDbName(migrateUrl, clone);
  process.env.E2E_THROWAWAY_DB = clone;
  const drop = async (): Promise<void> => {
    await withAdmin(adminUrl, (c) =>
      c.query(`DROP DATABASE IF EXISTS ${q(clone)} WITH (FORCE)`),
    );
  };
  try {
    assertThrowawayUrl(process.env.DATABASE_URL, 'DATABASE_URL');
    if (process.env.MIGRATE_DATABASE_URL) {
      assertThrowawayUrl(
        process.env.MIGRATE_DATABASE_URL,
        'MIGRATE_DATABASE_URL',
      );
    }
    const c = new pg.Client({ connectionString: cloneApp });
    await c.connect();
    try {
      const db = (
        await c.query<{ db: string }>(`SELECT current_database() AS db`)
      ).rows[0].db;
      if (db !== clone || !isThrowawayDbName(db)) {
        throw new Error(
          `current_database() is "${db}", not the throw-away clone`,
        );
      }
    } finally {
      await c.end();
    }
  } catch (e) {
    await drop().catch(() => undefined);
    throw e;
  }
  // 4. Teardown: verify the whole audit chain the run produced (genesis to head, every hash),
  // THEN drop the clone. A broken chain fails the run after the database is gone.
  return async (): Promise<void> => {
    let broken: string | null = null;
    try {
      const c = new pg.Client({
        connectionString: withDbName(adminUrl, clone),
      });
      await c.connect();
      try {
        const r = await new AuditChainVerifier().verify(
          (sql, params = []) =>
            c.query<Record<string, unknown>>(sql, params).then((x) => x.rows),
          { mode: 'full' },
        );
        console.log(
          `[e2e db] audit chain of ${clone} after the run: ${r.ok ? 'OK' : 'BROKEN'}, ${r.rows} rows verified from genesis (head seq ${r.lastSeq})`,
        );
        if (!r.ok) broken = JSON.stringify(r.brokenAt);
      } finally {
        await c.end();
      }
    } catch (e) {
      broken = `verification failed: ${String(e)}`;
    } finally {
      await drop();
    }
    if (broken)
      throw new Error(`Audit chain of the e2e run is broken: ${broken}`);
  };
}
