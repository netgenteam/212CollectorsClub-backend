/**
 * Story 22.9 (AC6): `prisma migrate deploy` of the Epic 22 migrations, for real, in (a) an empty database and (b) a
 * clone of the (throw-away) e2e database: the old `pack_simulator/config` is identical before and after, `migrate
 * status` is clean, and the rollback SQL written in each migration is executed in the clone.
 * Both databases are created and dropped by this file (never the e2e one itself).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { dbNameOf, withDbName } from './helpers/test-db.js';

const MIG_DIR = join(process.cwd(), 'prisma', 'migrations');
const FIRST = '20261115100000';
const EPIC = readdirSync(MIG_DIR)
  .filter((d) => /^\d{14}_/.test(d) && d.slice(0, 14) >= FIRST)
  .sort();
const KNOWN = [
  '20261115100000_add_simulator_manual_sets',
  '20261116100000_add_fx_source_states',
];
const SRC = dbNameOf(adminDatabaseUrl());
const TAG = Date.now().toString(36);
const CLEAN = `m229c_${TAG}`;
const CLONE = `m229k_${TAG}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withClient<T>(
  db: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const u = new URL(withDbName(adminDatabaseUrl(), db));
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const prismaCli = (db: string, ...args: string[]): string => {
  const url = withDbName(adminDatabaseUrl(), db);
  return execFileSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url, MIGRATE_DATABASE_URL: url },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};
/** SQL lines of the `-- ROLLBACK` comment of a migration (`--   <sql>;`). */
function rollbackSql(dir: string): string[] {
  const lines = readFileSync(join(MIG_DIR, dir, 'migration.sql'), 'utf8').split(
    '\n',
  );
  const i = lines.findIndex((l) => /^--\s*ROLLBACK/i.test(l));
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^--\s{2,}(\S.*;)\s*$/.exec(l);
    if (m) out.push(m[1]);
    else if (!/^--/.test(l)) break;
  }
  return out;
}

const OLD_CONFIG = {
  templates: {
    pokemon: {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 4 },
        { kind: 'rare', odds: { RARE: 100 } },
      ],
    },
  },
  sets: [
    {
      gameSlug: 'pokemon',
      setId: 'sv3',
      displayName: 'Simulador Prueba',
      imageUrl: '/uploads/public/landing/prueba.png',
    },
    { gameSlug: 'pokemon', setId: 'sv4', displayName: 'Otro set' },
  ],
};

describe('Epic 22 migrations (e2e, Story 22.9 AC6)', () => {
  beforeAll(async () => {
    await withClient('postgres', async (c) => {
      await c.query(`CREATE DATABASE "${CLEAN}"`);
      // CREATE DATABASE ... TEMPLATE needs a source nobody else is connected to: retry for up to ~60 s.
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          await c.query(`CREATE DATABASE "${CLONE}" TEMPLATE "${SRC}"`);
          return;
        } catch (e) {
          if (
            Date.now() > deadline ||
            !/being accessed by other users/i.test(String(e))
          )
            throw e;
          await sleep(1_500);
        }
      }
    });
  }, 90_000);
  afterAll(async () => {
    await withClient('postgres', async (c) => {
      for (const db of [CLEAN, CLONE])
        await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    });
  });

  it('the Epic 22 migrations are the 2 known ones (plus any later one, listed here)', () => {
    expect(EPIC.slice(0, 2)).toEqual(KNOWN);
  });

  it('empty database: migrate deploy applies everything, status is clean, the new tables exist', async () => {
    const out = prismaCli(CLEAN, 'migrate', 'deploy');
    for (const m of EPIC) expect(out).toContain(m);
    expect(prismaCli(CLEAN, 'migrate', 'status')).toMatch(/up to date/i);
    await withClient(CLEAN, async (c) => {
      const t = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['Simulator_Sets', 'Simulator_Cards', 'Fx_Source_States']],
      );
      expect(t.rows.map((r) => r.table_name).sort()).toEqual([
        'Fx_Source_States',
        'Simulator_Cards',
        'Simulator_Sets',
      ]);
      const sets = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Simulator_Sets"`,
      );
      expect(sets.rows[0].n).toBe(0);
    });
  }, 120_000);

  it('clone of the dev schema: deploy of the 2 migrations keeps the old config byte for byte, converts "simulador prueba", status clean; the documented rollback SQL runs and leaves the config untouched', async () => {
    const cfg = async (c: pg.Client) =>
      (
        await c.query<{ value: unknown }>(
          `SELECT value FROM "Landing_Config_Entries" WHERE section='pack_simulator' AND key='config'`,
        )
      ).rows[0]?.value;
    const configBefore = await withClient(CLONE, async (c) => {
      // A deployed-like state: the old config exists, the Epic 22 objects do not.
      for (const dir of [...EPIC].reverse())
        for (const stmt of rollbackSql(dir)) await c.query(stmt);
      await c.query(
        `DELETE FROM _prisma_migrations WHERE migration_name = ANY($1)`,
        [EPIC],
      );
      await c.query(
        `DELETE FROM "Landing_Config_Entries" WHERE section='pack_simulator' AND key='config'`,
      );
      await c.query(
        `INSERT INTO "Landing_Config_Entries" (id,section,key,"valueType",value,"updatedAt")
         VALUES (gen_random_uuid(),'pack_simulator','config','json',$1::jsonb, now())`,
        [JSON.stringify(OLD_CONFIG)],
      );
      const gone = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('Simulator_Sets','Simulator_Cards','Fx_Source_States')`,
      );
      expect(gone.rows[0].n).toBe(0);
      return cfg(c);
    });
    expect(configBefore).toEqual(OLD_CONFIG);

    const out = prismaCli(CLONE, 'migrate', 'deploy');
    for (const m of EPIC) expect(out).toContain(m);
    expect(out).not.toContain('20261114100000_retention_clock_simplify');
    expect(prismaCli(CLONE, 'migrate', 'status')).toMatch(/up to date/i);

    await withClient(CLONE, async (c) => {
      expect(await cfg(c)).toEqual(configBefore);
      const sets = await c.query<{
        name: string;
        isActive: boolean;
        imageUrl: string | null;
      }>(`SELECT name,"isActive","imageUrl" FROM "Simulator_Sets"`);
      expect(sets.rows).toEqual([
        {
          name: 'Simulador Prueba',
          isActive: false,
          imageUrl: '/uploads/public/landing/prueba.png',
        },
      ]);
      expect(
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "Simulator_Cards"`,
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "Fx_Source_States"`,
          )
        ).rows[0].n,
      ).toBe(0);

      // Rollback SQL of the two known migrations, exactly as documented in their comments.
      for (const dir of [...KNOWN].reverse()) {
        const stmts = rollbackSql(dir);
        expect(stmts.length, `rollback of ${dir}`).toBeGreaterThan(0);
        for (const stmt of stmts) await c.query(stmt);
      }
      const left = await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Simulator_Sets','Simulator_Cards','Fx_Source_States')`,
      );
      expect(left.rows).toEqual([]);
      expect(
        (
          await c.query(
            `SELECT 1 FROM pg_type WHERE typname='SimulatorRarityTier'`,
          )
        ).rowCount,
      ).toBe(0);
      expect(await cfg(c)).toEqual(configBefore);
    });
  }, 180_000);
});
