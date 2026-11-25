/**
 * Story 22.3 (AD-106, FR-148/155): constraints of the manual simulator tables against the real
 * (throw-away) database, and the idempotent "simulador prueba" conversion of the migration in a
 * sandbox schema with a synthetic old config (AD-103 pattern; the local DB has no `pack_simulator`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { defaultPokemonTemplate } from '../src/simulator/simulator-defaults.js';

const clientUrl = (): string => {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  return u.toString();
};

const TAG = `e2e-sim-${Date.now()}`;

describe('Simulator_Sets / Simulator_Cards constraints (AC1, AC3)', () => {
  const client = new pg.Client({ connectionString: clientUrl() });
  const setIds: string[] = [];

  const newSet = async (nameKey: string): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO "Simulator_Sets" ("id","name","nameKey","template","updatedAt")
       VALUES (gen_random_uuid(), $1, $1, '{"slots":[]}'::jsonb, now()) RETURNING "id"`,
      [nameKey],
    );
    const id = r.rows[0].id;
    setIds.push(id);
    return id;
  };
  const newCard = (
    setId: string,
    number: string | null,
    price: string | null = null,
  ) =>
    client.query(
      `INSERT INTO "Simulator_Cards" ("id","setId","name","rarityTier","number","numberKey","marketPriceUsd","updatedAt")
       VALUES (gen_random_uuid(), $1::uuid, 'C', 'COMMON', $2::varchar, lower($2::varchar), $3::numeric, now())`,
      [setId, number, price],
    );

  beforeAll(() => client.connect());
  afterAll(async () => {
    await client
      .query(`DELETE FROM "Simulator_Sets" WHERE "id" = ANY($1::uuid[])`, [
        setIds,
      ])
      .catch(() => undefined);
    await client.end();
  });

  it('defaults: inactive, version 1', async () => {
    const id = await newSet(`${TAG}-defaults`);
    const r = await client.query(
      `SELECT "isActive","version" FROM "Simulator_Sets" WHERE id=$1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ isActive: false, version: 1 });
  });

  it('duplicate (setId, lower(number)) violates uniqueness (case-insensitive, 22.10); two NULL numbers are allowed', async () => {
    const id = await newSet(`${TAG}-num`);
    await newCard(id, '001');
    await expect(newCard(id, '001')).rejects.toMatchObject({ code: '23505' });
    await newCard(id, 'tg12');
    await expect(newCard(id, 'TG12')).rejects.toMatchObject({ code: '23505' });
    await newCard(id, null);
    await newCard(id, null);
    const other = await newSet(`${TAG}-num2`);
    await newCard(other, '001'); // same number, other set: fine
  });

  it('marketPriceUsd = -1 violates the CHECK; 0 and NULL are fine', async () => {
    const id = await newSet(`${TAG}-price`);
    await expect(newCard(id, 'p1', '-1')).rejects.toMatchObject({
      code: '23514',
    });
    await newCard(id, 'p2', '0');
    await newCard(id, 'p3', null);
  });

  it('deleting the set deletes its cards (cascade)', async () => {
    const id = await newSet(`${TAG}-cascade`);
    await newCard(id, 'a');
    await newCard(id, 'b');
    await client.query(`DELETE FROM "Simulator_Sets" WHERE id=$1`, [id]);
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Simulator_Cards" WHERE "setId"=$1`,
      [id],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('duplicate nameKey violates uniqueness', async () => {
    await newSet(`${TAG}-dup`);
    await expect(newSet(`${TAG}-dup`)).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an unknown rarity tier', async () => {
    const id = await newSet(`${TAG}-enum`);
    await expect(
      client.query(
        `INSERT INTO "Simulator_Cards" ("id","setId","name","rarityTier","updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, 'C', 'PROMO', now())`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});

describe('migration data step in a sandbox schema (AC4, AC5)', () => {
  const MIG_DIR = join(__dirname, '..', 'prisma', 'migrations');
  const sql = readFileSync(
    join(
      MIG_DIR,
      readdirSync(MIG_DIR).find((d) =>
        d.endsWith('_add_simulator_manual_sets'),
      )!,
      'migration.sql',
    ),
    'utf8',
  );
  const MARK = '-- DATA STEP';
  const dataStep = `${sql.slice(sql.indexOf(MARK))}`.replace(
    /\nCOMMIT;\s*$/,
    '',
  );
  const ddl = sql.slice(0, sql.indexOf(MARK)) + '\nCOMMIT;';
  const schema = `sim_mig_${Date.now()}`;
  const client = new pg.Client({ connectionString: clientUrl() });

  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => (await client.query<T>(text, params)).rows;

  const setConfig = async (value: object | null) => {
    await q(`DELETE FROM "Landing_Config_Entries"`);
    if (value !== null)
      await q(
        `INSERT INTO "Landing_Config_Entries" (section,key,value) VALUES ('pack_simulator','config',$1::jsonb)`,
        [JSON.stringify(value)],
      );
  };
  const runData = () => client.query(`BEGIN;${dataStep}\nCOMMIT;`);
  const sets = () =>
    q<{
      name: string;
      nameKey: string;
      imageUrl: string | null;
      template: unknown;
      isActive: boolean;
    }>(
      `SELECT name,"nameKey","imageUrl",template,"isActive" FROM "Simulator_Sets" ORDER BY "nameKey"`,
    );
  const reset = () => q(`DELETE FROM "Simulator_Sets"`);

  const ownTemplate = {
    slots: [
      { kind: 'fixed', tier: 'COMMON', count: 2 },
      { kind: 'rare', odds: { RARE: 100 } },
    ],
  };
  const gameTemplate = {
    slots: [
      { kind: 'fixed', tier: 'UNCOMMON', count: 1 },
      { kind: 'rare', odds: { DOUBLE_RARE: 100 } },
    ],
  };

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(
      `CREATE TABLE "Landing_Config_Entries" (id uuid DEFAULT gen_random_uuid(), section text, key text, value jsonb NOT NULL)`,
    );
    await client.query(
      `CREATE TABLE "Tcg_Ingest_Cursors" ("gameSlug" text, "setId" text, "setName" text)`,
    );
    await client.query(ddl);
  });
  afterAll(async () => {
    await client
      .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => undefined);
    await client.end();
  });

  it('sandbox DDL created the tables in the sandbox schema, not in public', async () => {
    const r = await q<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables WHERE table_name='Simulator_Sets' AND table_schema=$1`,
      [schema],
    );
    expect(r).toHaveLength(1);
  });

  it('(a) "Simulador Prueba" with own template and image => 1 inactive set, 0 cards; idempotent; config untouched', async () => {
    const cfg = {
      templates: { pokemon: gameTemplate },
      sets: [
        { gameSlug: 'pokemon', setId: 'x1', displayName: 'Otro set' },
        {
          gameSlug: 'pokemon',
          setId: 'sp',
          displayName: '  Simulador Prueba ',
          imageUrl: '/uploads/public/landing/abc.png',
          template: ownTemplate,
        },
      ],
    };
    await setConfig(cfg);
    const before = await q(`SELECT value FROM "Landing_Config_Entries"`);
    await runData();
    const first = await sets();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      isActive: false,
      imageUrl: '/uploads/public/landing/abc.png',
      template: ownTemplate,
      nameKey: 'simulador prueba',
    });
    expect(first[0].name).toBe('Simulador Prueba');
    expect(
      (await q(`SELECT count(*)::int AS n FROM "Simulator_Cards"`))[0].n,
    ).toBe(0);
    await runData();
    expect(await sets()).toEqual(first); // second application: no duplicate, nothing changed
    expect(await q(`SELECT value FROM "Landing_Config_Entries"`)).toEqual(
      before,
    );
  });

  it('(a2) uppercase name matches (SIMULADOR PRUEBA)', async () => {
    await reset();
    await setConfig({
      templates: {},
      sets: [
        { gameSlug: 'pokemon', setId: 'u', displayName: 'SIMULADOR PRUEBA' },
      ],
    });
    await runData();
    expect(await sets()).toHaveLength(1);
  });

  it('(b) without own template falls back to templates[gameSlug], then to the default', async () => {
    await reset();
    await setConfig({
      templates: { pokemon: gameTemplate },
      sets: [
        { gameSlug: 'pokemon', setId: 'g', displayName: 'Simulador Prueba' },
      ],
    });
    await runData();
    const viaGame = await sets();
    expect(viaGame).toHaveLength(1);
    expect(viaGame[0].template).toEqual(gameTemplate);
    expect(viaGame[0].imageUrl).toBeNull();

    await reset();
    await setConfig({
      templates: {},
      sets: [
        { gameSlug: 'pokemon', setId: 'g', displayName: 'Simulador Prueba' },
      ],
    });
    await runData();
    const viaDefault = await sets();
    expect(viaDefault[0].template).toEqual(defaultPokemonTemplate());
  });

  it('(c) no config, or no such name => 0 rows (no-op)', async () => {
    await reset();
    await setConfig(null);
    await runData();
    expect(await sets()).toHaveLength(0);
    await setConfig({
      templates: {},
      sets: [{ gameSlug: 'pokemon', setId: 'z', displayName: 'Otro' }],
    });
    await runData();
    expect(await sets()).toHaveLength(0);
    await setConfig({ templates: {}, sets: 'not-an-array' });
    await runData();
    expect(await sets()).toHaveLength(0);
  });

  it('(d) without displayName the cursor setName resolves the name', async () => {
    await reset();
    await q(`DELETE FROM "Tcg_Ingest_Cursors"`);
    await q(
      `INSERT INTO "Tcg_Ingest_Cursors" ("gameSlug","setId","setName") VALUES ('pokemon','cur','simulador PRUEBA')`,
    );
    await setConfig({
      templates: {},
      sets: [
        { gameSlug: 'pokemon', setId: 'cur' },
        { gameSlug: 'pokemon', setId: 'nocursor' },
      ],
    });
    await runData();
    const r = await sets();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: 'simulador PRUEBA',
      nameKey: 'simulador prueba',
    });
  });

  it('two matching elements collapse into one row (DISTINCT ON nameKey)', async () => {
    await reset();
    await setConfig({
      templates: {},
      sets: [
        { gameSlug: 'pokemon', setId: 'a', displayName: 'Simulador Prueba' },
        { gameSlug: 'pokemon', setId: 'b', displayName: 'simulador prueba' },
      ],
    });
    await runData();
    expect(await sets()).toHaveLength(1);
  });

  it('a pre-existing set with the same nameKey is left alone (ON CONFLICT DO NOTHING)', async () => {
    await reset();
    await q(
      `INSERT INTO "Simulator_Sets" (id,name,"nameKey",template,"isActive","updatedAt") VALUES (gen_random_uuid(),'Simulador Prueba','simulador prueba','{"slots":[]}'::jsonb,true,now())`,
    );
    await setConfig({
      templates: {},
      sets: [
        { gameSlug: 'pokemon', setId: 'a', displayName: 'Simulador Prueba' },
      ],
    });
    await runData();
    const r = await sets();
    expect(r).toHaveLength(1);
    expect(r[0].isActive).toBe(true);
  });
});
