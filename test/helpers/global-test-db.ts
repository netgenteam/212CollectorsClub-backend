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
 *     clones a database nobody else is connected to (and every refused attempt itself waits
 *     ~5 s for the other sessions to leave): it retries until a TOTAL of ~60 s have passed
 *     (a deadline, not an attempt count: 40 attempts took 272 s) and then aborts telling the
 *     developer to stop the dev server (no session is killed). The clone is tagged with a
 *     `COMMENT ON DATABASE` that only this run knows.
 *  3. Point `DATABASE_URL` (and `MIGRATE_DATABASE_URL` if set) of the run at the clone
 *     BEFORE the workers are forked, and verify with `current_database()` that the
 *     run really is on a throw-away database (abort otherwise).
 *  4. Teardown: `DROP DATABASE ... WITH (FORCE)` of this run's clone only, after a POSITIVE
 *     check (`assertDroppable`): the name is a clone name, it is neither the source nor the
 *     database `DATABASE_URL` pointed at, it exists, and its comment is this run's tag.
 * The role that clones needs CREATEDB (the owner / `MIGRATE_DATABASE_URL`).
 */
const STALE_SECONDS = 3 * 3600;
/** Total time allowed to get a quiet template (see 2 above). */
export const CLONE_DEADLINE_MS = 60_000;
const CLONE_WAIT_MS = 1_500;
const MARKER_PREFIX = 'cc-e2e-throwaway run=';

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

/**
 * Positive check run right before every teardown `DROP DATABASE`: the statement is only issued if
 * ALL of these hold, otherwise it throws and nothing is dropped.
 *  - `clone` has the throw-away name format and `base` is the prefix of the source;
 *  - it is not the source database nor the database the run was configured with;
 *  - it exists in `pg_database`, and its comment is the marker this run wrote when it created it.
 */
export async function assertDroppable(
  c: Pick<pg.Client, 'query'>,
  clone: string,
  marker: string,
  protectedNames: string[],
): Promise<void> {
  if (!isThrowawayDbName(clone)) {
    throw new Error(`Refusing to DROP "${clone}": not a throw-away name.`);
  }
  if (protectedNames.includes(clone)) {
    throw new Error(
      `Refusing to DROP "${clone}": it is a configured database.`,
    );
  }
  const r = await c.query<{ marker: string | null }>(
    `SELECT shobj_description(d.oid, 'pg_database') AS marker
       FROM pg_database d WHERE d.datname = $1`,
    [clone],
  );
  if (r.rows.length !== 1) {
    throw new Error(
      `Refusing to DROP "${clone}": it does not exist (exactly one row expected).`,
    );
  }
  if (r.rows[0].marker !== marker) {
    throw new Error(
      `Refusing to DROP "${clone}": its comment is not the marker of this run (it was not created by it).`,
    );
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

  const marker = `${MARKER_PREFIX}${randomBytes(8).toString('hex')}`;
  const protectedNames = [...new Set([sourceName, dbNameOf(appUrl)])];
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
    // 2. Clone (retry while someone else is connected to the template). A DEADLINE, not an attempt
    //    count: a refused attempt already waits ~5 s inside Postgres for the other sessions.
    let last: unknown;
    const t0 = performance.now();
    for (;;) {
      try {
        await c.query(`CREATE DATABASE ${q(clone)} TEMPLATE ${q(sourceName)}`);
        // Only this run knows the tag: the teardown refuses to drop anything else.
        await c.query(`COMMENT ON DATABASE ${q(clone)} IS '${marker}'`);
        return;
      } catch (e) {
        last = e;
        if ((e as { code?: string }).code !== '55006') break; // not "being accessed"
        if (performance.now() - t0 >= CLONE_DEADLINE_MS) break;
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
    await withAdmin(adminUrl, async (c) => {
      await assertDroppable(c, clone, marker, protectedNames);
      await c.query(`DROP DATABASE ${q(clone)} WITH (FORCE)`);
    });
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
      // Story 20.7 round 4: a database that was only migrated (CI, a disposable container) has no `default`
      // row of `Fx_Rate_Settings` (`prisma/seed.ts` creates it, no migration does): 313 e2e and two perf
      // specs failed on it. Only here, in the clone that was just verified to be one, it is created when
      // missing (the value the seed uses); a database that already has it is not touched, and the real
      // database never is.
      await c.query(
        `INSERT INTO "Fx_Rate_Settings" ("id", "vesPerUsd", "updatedAt", "rateFetchedAt")
         VALUES ('default', 200, now(), now()) ON CONFLICT ("id") DO NOTHING`,
      );
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
