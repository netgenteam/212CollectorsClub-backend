import pg from 'pg';
import {
  adminDatabaseUrl,
  createAuditSandbox,
  type AuditSandbox,
} from './helpers/audit-sandbox.js';

/**
 * Story 20.1 (QA round 4, B1): a role that may create temporary objects must not be able to
 * stand a TEMPORARY table/view in for "Audit_Events" / "Legal_Documents" /
 * "Legal_Document_Versions" and fool the trigger functions. Postgres searches `pg_temp`
 * FIRST for relations and types unless the search_path lists it, and `SET search_path FROM
 * CURRENT` (round 3) did not. Migration 20261107100000 lists `pg_catalog, public, pg_temp`.
 *
 * Every attempt runs inside a transaction that is ALWAYS rolled back (temporary objects and
 * rows vanish with it), with the connection of `adminDatabaseUrl()` (the owner, or the app
 * role when there is a single URL): both can create temporary tables unless the database
 * revoked TEMPORARY (`pnpm db:roles`), in which case the attack is impossible at the first
 * step (42501) and that is accepted as well. The audit part runs in a throwaway sandbox
 * schema (the real Audit_Events must never get a row); the Epic 19 part runs against the
 * real tables in `public` inside the rolled-back transaction.
 */
const cleanUrl = () => {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  return u.toString();
};
const code = (e: unknown) => (e as { code?: string }).code;

describe('pg_temp cannot stand in for a real table inside a trigger function (e2e, Story 20.1 B1)', () => {
  let c: pg.Client;

  beforeAll(async () => {
    c = new pg.Client({ connectionString: cleanUrl() });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });
  afterEach(async () => {
    await c.query('ROLLBACK').catch(() => undefined);
  });

  /** SQLSTATE of a statement run inside a savepoint (undefined = it was ACCEPTED). */
  const attempt = async (q: string): Promise<string | undefined> => {
    await c.query('SAVEPOINT a');
    try {
      await c.query(q);
      return undefined;
    } catch (e) {
      return code(e);
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT a');
    }
  };

  /** Runs the setup; false when TEMPORARY is revoked (the attack cannot even start). */
  const setup = async (q: string): Promise<boolean> => {
    await c.query('SAVEPOINT s');
    try {
      await c.query(q);
      return true;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      if (code(e) === '42501') return false;
      throw e;
    }
  };

  it('every function owned by the project pins search_path = pg_catalog, <schema>, pg_temp (the real database)', async () => {
    const r = await c.query<{ sig: string; cfg: string[] | null }>(
      `SELECT p."oid"::regprocedure::text AS sig, p."proconfig" AS cfg
         FROM pg_proc p
        WHERE p."pronamespace" = 'public'::regnamespace
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d."objid" = p."oid" AND d."deptype" = 'e')
        ORDER BY 1`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(14);
    const bad = r.rows.filter((row) => {
      const sp = (row.cfg ?? []).find((x) => x.startsWith('search_path='));
      if (!sp) return true;
      const list = sp
        .slice('search_path='.length)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''));
      return (
        list[0] !== 'pg_catalog' ||
        list[list.length - 1] !== 'pg_temp' ||
        list.length < 3
      );
    });
    expect(bad.map((x) => x.sig)).toEqual([]);
  });

  describe('audit chain guard (sandbox schema)', () => {
    let sb: AuditSandbox;
    beforeAll(async () => {
      sb = await createAuditSandbox();
    });
    afterAll(async () => {
      await sb?.drop();
    });

    const ins = (seq: number, prev: string, hash: string, at = 'now()') =>
      `INSERT INTO "${sb.schema}"."Audit_Events"("seq","prevHash","hash","occurredAt","action","entityType","entityId","actorType")
       VALUES (${seq}, repeat('${prev}',64), repeat('${hash}',64), ${at}, 'AUDIT_VERIFIED','T','1','SYSTEM')`;

    it('the honest first row is accepted (the sandbox works)', async () => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL search_path TO "${sb.schema}", public`);
      expect(
        await attempt(
          `INSERT INTO "${sb.schema}"."Audit_Events"("seq","prevHash","hash","occurredAt","action","entityType","entityId","actorType")
           VALUES (1, repeat('0',64), repeat('a',64), now(), 'AUDIT_VERIFIED','T','1','SYSTEM')`,
        ),
      ).toBeUndefined();
    });

    it.each([
      [
        'temporary TABLE with the name of the audit table',
        `CREATE TEMP TABLE "Audit_Events"(seq bigint, hash char(64), "occurredAt" timestamptz);
         INSERT INTO pg_temp."Audit_Events" VALUES (49, repeat('a',64), now() - interval '10 s')`,
      ],
      [
        'temporary VIEW with the name of the audit table',
        `CREATE TEMP VIEW "Audit_Events" AS SELECT 49::bigint AS seq, repeat('a',64)::char(64) AS hash, now() - interval '10 s' AS "occurredAt"`,
      ],
    ])(
      '%s: a row that continues the FAKE head is rejected',
      async (_n, setupSql) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL search_path TO "${sb.schema}", public`);
        if (!(await setup(setupSql))) return;
        expect(await attempt(ins(50, 'a', 'b'))).toBe('23000');
        // ... also with the temporary schema FIRST in the session path.
        await c.query(
          `SET LOCAL search_path TO pg_temp, "${sb.schema}", public`,
        );
        expect(await attempt(ins(50, 'a', 'b'))).toBe('23000');
      },
    );

    it('temporary FUNCTIONS and OPERATORS with built-in names are never picked up, even with pg_temp first', async () => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL search_path TO "${sb.schema}", public`);
      await c.query(ins(1, '0', 'c'));
      const ok = await setup(`
        CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() + interval '10 years' $$;
        CREATE FUNCTION pg_temp.current_setting(text, boolean) RETURNS text LANGUAGE sql AS $$ SELECT 'on'::text $$;
        CREATE FUNCTION pg_temp.pg_has_role(name, oid, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
        CREATE FUNCTION pg_temp.never(bigint, bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
        CREATE OPERATOR pg_temp.<> (LEFTARG = bigint, RIGHTARG = bigint, FUNCTION = pg_temp.never)`);
      if (!ok) return;
      await c.query(
        `SET LOCAL search_path TO pg_temp, pg_catalog, "${sb.schema}", public`,
      );
      // (the restore flag is NOT set: a fake current_setting/pg_has_role would turn it on)
      // a backwards occurredAt, a skipped seq and a fork stay rejected
      expect(await attempt(ins(2, 'c', 'd', `now() - interval '1 day'`))).toBe(
        '23000',
      );
      expect(await attempt(ins(9, 'c', 'd'))).toBe('23000');
      expect(await attempt(ins(2, 'f', 'd'))).toBe('23000');
    });
  });

  describe('Epic 19 triggers (real tables, one rolled-back transaction)', () => {
    const insertVersion = (
      effectiveFrom: string,
      versionNumber: number,
    ): string =>
      `INSERT INTO public."Legal_Document_Versions"("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
       SELECT gen_random_uuid(), "id", ${versionNumber}, 'x', 'x', false, ${effectiveFrom}
         FROM public."Legal_Documents" WHERE "slug" = 'cookies'`;

    it('the baseline: a back-dated version of a real document is rejected', async () => {
      await c.query('BEGIN');
      expect(
        await attempt(insertVersion(`now() - interval '300 days'`, 1)),
      ).toBe('23000');
    });

    it.each([
      [
        'temporary COPY of Legal_Documents with isSandbox = true',
        `CREATE TEMP TABLE "Legal_Documents" AS SELECT * FROM public."Legal_Documents";
         UPDATE pg_temp."Legal_Documents" SET "isSandbox" = true`,
      ],
      [
        'temporary VIEW Legal_Documents with isSandbox = true',
        `CREATE TEMP VIEW "Legal_Documents" AS SELECT "id", true AS "isSandbox" FROM public."Legal_Documents"`,
      ],
    ])('%s does not exempt a back-dated version', async (_n, setupSql) => {
      await c.query('BEGIN');
      if (!(await setup(setupSql))) return;
      expect(
        await attempt(insertVersion(`now() - interval '300 days'`, 1)),
      ).toBe('23000');
    });

    it('a temporary Legal_Document_Versions does not feed a fake max(versionNumber)', async () => {
      await c.query('BEGIN');
      if (
        !(await setup(`
          CREATE TEMP TABLE "Legal_Document_Versions"("documentId" uuid, "versionNumber" int, "effectiveFrom" timestamptz);
          INSERT INTO pg_temp."Legal_Document_Versions" SELECT "id", 98, now() FROM public."Legal_Documents" WHERE "slug" = 'cookies'`))
      ) {
        return;
      }
      expect(
        await attempt(insertVersion(`now() + interval '1 hour'`, 99)),
      ).toBe('23000');
    });

    it('a consent cannot be forged through temporary copies of the document tables', async () => {
      await c.query('BEGIN');
      // a real, future COOKIES version (valid), which the real guard does not accept as PRIVACY
      await c.query(
        `INSERT INTO public."Legal_Document_Versions"("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
         SELECT '11111111-1111-4111-8111-111111111111', "id", (SELECT coalesce(max("versionNumber"), 0) + 1 FROM public."Legal_Document_Versions" WHERE "documentId" = d."id"), 'x', 'x', false, now() + interval '1 hour'
           FROM public."Legal_Documents" d WHERE d."slug" = 'cookies'`,
      );
      const v = await c.query<{ n: number }>(
        `SELECT "versionNumber" AS n FROM public."Legal_Document_Versions" WHERE "id" = '11111111-1111-4111-8111-111111111111'`,
      );
      const n = v.rows[0].n;
      if (
        !(await setup(`
          CREATE TEMP TABLE "Legal_Document_Versions"("id" uuid, "documentId" uuid, "versionNumber" int, "effectiveFrom" timestamptz);
          INSERT INTO pg_temp."Legal_Document_Versions" SELECT '11111111-1111-4111-8111-111111111111', "id", ${n}, now() - interval '1 day' FROM public."Legal_Documents" WHERE "slug" = 'cookies';
          CREATE TEMP TABLE "Legal_Documents"("id" uuid, "kind" "LegalDocKind");
          INSERT INTO pg_temp."Legal_Documents" SELECT "id", 'PRIVACY' FROM public."Legal_Documents" WHERE "slug" = 'cookies'`))
      ) {
        return;
      }
      expect(
        await attempt(
          `INSERT INTO public."Consent_Records"("id","type","documentVersionId","version","context")
           VALUES (gen_random_uuid(), 'PRIVACY', '11111111-1111-4111-8111-111111111111', ${n}, 'REGISTER')`,
        ),
      ).toBe('23000');
    });
  });
});
