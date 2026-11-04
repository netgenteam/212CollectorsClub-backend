/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access -- pg rows are untyped; the audit callbacks must return a Promise by signature */
import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import { ApiException } from './../src/common/api-exception.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import type { SqlRunner } from './../src/audit/audit-chain-verifier.js';
import {
  AuditService,
  AUDIT_CHAIN_LOCK_KEY,
} from './../src/audit/audit.service.js';
import {
  GENESIS_HASH,
  computeAuditHash,
} from './../src/audit/canonical-json.js';
import {
  adminDatabaseUrl,
  auditMigrationSql,
  createAuditSandbox,
  withoutTransaction,
} from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';

/**
 * Story 20.1 (AC2, AC5, AC6, AC8): AuditService against SANDBOX schemas only.
 * `Audit_Events` of the real database is never touched (it is immutable, a test
 * row there could never be removed). No trigger is disabled anywhere: the
 * "manipulated" chain lives in a sandbox built without the triggers.
 */
interface Boxed {
  sb: AuditSandbox;
  prisma: PrismaService;
  audit: AuditService;
  runner: SqlRunner;
}

async function box(
  opts: { noTriggers?: boolean; extraSql?: string } = {},
): Promise<Boxed> {
  const sb = await createAuditSandbox(opts);
  const prisma = new PrismaService(new ConfigService({ DATABASE_URL: sb.url }));
  await prisma.onModuleInit();
  return {
    sb,
    prisma,
    audit: new AuditService(prisma),
    runner: (sql, params = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params),
  };
}

const unbox = async (b: Boxed): Promise<void> => {
  await b.prisma.onModuleDestroy();
  await b.sb.drop();
};

const sqlstate = (e: unknown): string | undefined =>
  (e as { code?: string }).code;

describe('AuditService / chain / immutability on sandbox schemas (e2e, Story 20.1)', () => {
  const boxes: Boxed[] = [];
  const make = async (o?: Parameters<typeof box>[0]) => {
    const b = await box(o);
    boxes.push(b);
    return b;
  };

  afterAll(async () => {
    for (const b of boxes) await unbox(b);
  });

  it('the sandbox really is a separate table (search_path reaches Prisma raw queries)', async () => {
    const b = await make();
    const r = await b.prisma.$queryRawUnsafe<{ s: string }[]>(
      `SELECT schemaname AS s FROM pg_tables WHERE tablename = 'Audit_Events' AND schemaname = $1`,
      b.sb.schema,
    );
    expect(r).toHaveLength(1);
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({
        actorType: 'SYSTEM',
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: '1',
      });
    });
    const inSandbox = await b.sb.exec(
      `SELECT count(*)::int AS n FROM "Audit_Events"`,
    );
    expect(inSandbox[0].n).toBe(1);
  });

  it('AC6: 50 concurrent AuditService.transaction => gapless seq, linked prevHash, no fork, verify OK, no 5xx', async () => {
    const b = await make();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        b.audit.transaction(async (tx, audit) => {
          await tx.$executeRaw`SELECT 1`;
          audit.add({
            actorType: 'ADMIN',
            actorId: randomUUID(),
            action: 'ORDER_STATUS_CHANGED',
            entityType: 'ORDER',
            entityId: `o-${i}`,
            before: { status: 'PAID' },
            after: { status: 'SHIPPED', n: i },
            requestId: randomUUID(),
            ip: '203.0.113.7',
          });
          return i;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const rows = await b.sb.exec(
      `SELECT "seq"::int AS seq, "prevHash", "hash" FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(rows).toHaveLength(50);
    rows.forEach((r, i) => {
      expect(r.seq).toBe(i + 1);
      expect(r.prevHash).toBe(i === 0 ? GENESIS_HASH : rows[i - 1].hash);
    });
    expect(new Set(rows.map((r) => r.hash)).size).toBe(50);
    const v = await new AuditChainVerifier().verify(b.runner, { mode: 'full' });
    expect(v).toMatchObject({
      ok: true,
      rows: 50,
      checkedFrom: 1,
      checkedTo: 50,
      done: true,
    });
  });

  it('AC6: concurrent multi-event transactions keep ONE lock per flush and a linear chain', async () => {
    const b = await make();
    await Promise.all(
      Array.from({ length: 20 }, (_, t) =>
        b.audit.transaction(async (_tx, audit) => {
          for (let k = 0; k < 3; k++) {
            audit.add({
              actorType: 'SYSTEM',
              action: 'RETENTION_PURGE_RUN',
              entityType: 'RUN',
              entityId: `${t}-${k}`,
              after: { t, k },
            });
          }
        }),
      ),
    );
    // Events of one transaction are contiguous (they share the lock).
    const rows = await b.sb.exec(
      `SELECT "seq"::int AS seq, "entityId" FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(rows).toHaveLength(60);
    for (let i = 0; i < 60; i += 3) {
      const t = (rows[i].entityId as string).split('-')[0];
      expect(rows[i + 1].entityId).toBe(`${t}-1`);
      expect(rows[i + 2].entityId).toBe(`${t}-2`);
    }
    expect(
      (await new AuditChainVerifier().verify(b.runner, { mode: 'full' })).ok,
    ).toBe(true);
  });

  it('the ip is hashed as Postgres prints it back (IPv6 case/compression, IPv4-mapped)', async () => {
    const b = await make();
    await b.audit.transaction(async (_tx, audit) => {
      for (const ip of [
        '2001:DB8:0:0:0:0:0:1',
        '::ffff:127.0.0.1',
        '10.0.0.1',
        'not-an-ip',
      ]) {
        audit.add({
          actorType: 'ANON',
          action: 'LOGIN_ADMIN_FAILED',
          entityType: 'ADMIN_USER',
          entityId: 'x',
          ip,
        });
      }
    });
    const rows = await b.sb.exec(
      `SELECT host("ip") AS ip FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(rows.map((r) => r.ip)).toEqual([
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '10.0.0.1',
      null,
    ]);
    expect(
      (await new AuditChainVerifier().verify(b.runner, { mode: 'full' })).ok,
    ).toBe(true);
  });

  it('AC5: record(tx) is fail-closed: a failing audit insert rolls the audited action back (503 AUDIT_UNAVAILABLE, never 500)', async () => {
    const b = await make({
      extraSql: `
        CREATE TABLE biz_t (id int PRIMARY KEY);
        CREATE FUNCTION audit_t_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE = 'integrity_constraint_violation'; END $$;
      `,
    });
    // Healthy first: the action and its event commit together.
    await b.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO biz_t VALUES (1)`;
      await b.audit.record(tx, {
        actorType: 'SYSTEM',
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: '1',
      });
    });
    expect((await b.sb.exec(`SELECT count(*)::int AS n FROM biz_t`))[0].n).toBe(
      1,
    );

    await b.sb.exec(
      `CREATE TRIGGER audit_t_boom BEFORE INSERT ON "Audit_Events" FOR EACH ROW EXECUTE FUNCTION audit_t_boom()`,
    );

    // The P2010 error of a trigger reaches us through the pg adapter nested in meta.driverAdapterError.cause.code
    const raw = await b.prisma
      .$queryRawUnsafe(
        `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","action","entityType","entityId","prevHash","hash") VALUES (99, now(), 'SYSTEM', 'X', 'T', '1', repeat('0',64), repeat('1',64))`,
      )
      .catch(
        (e: unknown) =>
          e as {
            code?: string;
            meta?: { driverAdapterError?: { cause?: { code?: string } } };
          },
      );
    expect((raw as { code?: string }).code).toBe('P2010');
    expect(
      (raw as { meta?: { driverAdapterError?: { cause?: { code?: string } } } })
        .meta?.driverAdapterError?.cause?.code,
    ).toBe('23000');

    let thrown: unknown;
    await b.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO biz_t VALUES (2)`;
        await b.audit.record(tx, {
          actorType: 'SYSTEM',
          action: 'AUDIT_VERIFIED',
          entityType: 'T',
          entityId: '2',
        });
      })
      .catch((e: unknown) => (thrown = e));
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((thrown as ApiException).getResponse()).toMatchObject({
      errorCode: 'AUDIT_UNAVAILABLE',
      details: { reason: 'WRITE_FAILED' },
    });
    expect((await b.sb.exec(`SELECT count(*)::int AS n FROM biz_t`))[0].n).toBe(
      1,
    ); // action 2 rolled back
    expect(
      (await b.sb.exec(`SELECT count(*)::int AS n FROM "Audit_Events"`))[0].n,
    ).toBe(1);

    // same through transaction(): the collector flush failing reverts the body
    let thrown2: unknown;
    await b.audit
      .transaction(async (tx, audit) => {
        await tx.$executeRaw`INSERT INTO biz_t VALUES (3)`;
        audit.add({
          actorType: 'SYSTEM',
          action: 'AUDIT_VERIFIED',
          entityType: 'T',
          entityId: '3',
        });
      })
      .catch((e: unknown) => (thrown2 = e));
    expect((thrown2 as ApiException).getStatus()).toBe(503);
    expect((await b.sb.exec(`SELECT count(*)::int AS n FROM biz_t`))[0].n).toBe(
      1,
    );

    // a business error of the action is NOT rewritten (and writes no event)
    const biz = new ApiException(
      HttpStatus.CONFLICT,
      'INSUFFICIENT_STOCK',
      'x',
    );
    await expect(
      b.audit.transaction(async (_tx, audit) => {
        audit.add({
          actorType: 'SYSTEM',
          action: 'AUDIT_VERIFIED',
          entityType: 'T',
          entityId: '4',
        });
        throw biz;
      }),
    ).rejects.toBe(biz);
  });

  it('a malformed event (unknown action, float in before/after, PII) is rejected before any SQL and reverts the action', async () => {
    const b = await make({
      extraSql: `CREATE TABLE biz_t (id int PRIMARY KEY);`,
    });
    const bad = [
      { action: 'NOT_IN_CATALOG' },
      { action: 'AUDIT_VERIFIED', after: { price: 1.5 } },
      { action: 'AUDIT_VERIFIED', after: { email: 'a@b.co' } },
      { action: 'AUDIT_VERIFIED', actorId: 'nope' },
      { action: 'AUDIT_VERIFIED', entityId: 'x'.repeat(129) },
    ];
    for (const extra of bad) {
      await expect(
        b.audit.transaction(async (tx, audit) => {
          await tx.$executeRaw`INSERT INTO biz_t VALUES (1)`;
          audit.add({
            actorType: 'SYSTEM',
            entityType: 'T',
            entityId: '1',
            ...extra,
          } as never);
        }),
      ).rejects.toThrow(/Invalid audit/);
    }
    expect((await b.sb.exec(`SELECT count(*)::int AS n FROM biz_t`))[0].n).toBe(
      0,
    );
  });

  it('lock wait: a held chain-head lock gives a clean 503 AUDIT_UNAVAILABLE (LOCK_TIMEOUT) within ~5 s, never a 500, and the action reverts', async () => {
    const b = await make({
      extraSql: `CREATE TABLE biz_t (id int PRIMARY KEY);`,
    });
    const holder = new pg.Client({
      connectionString: (() => {
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        return u.toString();
      })(),
    });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`,
      );
      const t0 = process.hrtime.bigint();
      let thrown: unknown;
      await b.audit
        .transaction(async (tx, audit) => {
          await tx.$executeRaw`INSERT INTO biz_t VALUES (1)`;
          audit.add({
            actorType: 'SYSTEM',
            action: 'AUDIT_VERIFIED',
            entityType: 'T',
            entityId: '1',
          });
        })
        .catch((e: unknown) => (thrown = e));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(thrown).toBeInstanceOf(ApiException);
      expect((thrown as ApiException).getStatus()).toBe(503);
      expect((thrown as ApiException).getResponse()).toMatchObject({
        errorCode: 'AUDIT_UNAVAILABLE',
        details: { reason: 'LOCK_TIMEOUT' },
      });
      expect(ms).toBeGreaterThan(4_500);
      expect(ms).toBeLessThan(8_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    expect((await b.sb.exec(`SELECT count(*)::int AS n FROM biz_t`))[0].n).toBe(
      0,
    );
    // and the lock is usable again right after
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({
        actorType: 'SYSTEM',
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: 'again',
      });
    });
  }, 30_000);

  it('AC2: UPDATE / DELETE / TRUNCATE as the owner hit the trigger (SQLSTATE 23000), and the chain guard rejects a fork or a gap', async () => {
    const b = await make();
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({
        actorType: 'SYSTEM',
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: '1',
      });
    });
    for (const [what, q] of [
      ['UPDATE', `UPDATE "Audit_Events" SET "reason" = 'x'`],
      ['DELETE', `DELETE FROM "Audit_Events"`],
      ['TRUNCATE', `TRUNCATE "Audit_Events"`],
    ] as const) {
      const e = await b.sb.exec(q).catch((x: unknown) => x);
      expect(sqlstate(e)).toBe('23000');
      expect(String((e as Error).message)).toContain(
        `immutable: ${what} rejected`,
      );
    }
    const head = (
      await b.sb.exec(`SELECT "seq"::int AS seq, "hash" FROM "Audit_Events"`)
    )[0];
    const ins = (seq: number, prev: string) =>
      b.sb.exec(
        `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","action","entityType","entityId","prevHash","hash")
         VALUES ($1, now(), 'SYSTEM', 'X', 'T', '1', $2, $3)`,
        [seq, prev, 'a'.repeat(64)],
      );
    expect(
      sqlstate(await ins(5, head.hash as string).catch((x: unknown) => x)),
    ).toBe('23000'); // gap
    expect(
      sqlstate(await ins(2, 'b'.repeat(64)).catch((x: unknown) => x)),
    ).toBe('23000'); // wrong prevHash (fork)
    expect(sqlstate(await ins(1, GENESIS_HASH).catch((x: unknown) => x))).toBe(
      '23000',
    ); // duplicate seq: the chain guard (BEFORE INSERT) fires before the PK
  });

  it('restore: the trigger functions carry their own search_path (pg_dump sets an EMPTY one), and only an explicit owner session may replay an old non-monotonic pair', async () => {
    const b = await make();
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({
        actorType: 'SYSTEM',
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: '1',
      });
    });
    const cfg = await b.sb.exec(
      `SELECT p."proname", p."proconfig"::text AS cfg FROM pg_proc p
         JOIN pg_namespace n ON n."oid" = p."pronamespace"
        WHERE n."nspname" = $1 ORDER BY 1`,
      [b.sb.schema],
    );
    expect(cfg.map((r) => r.proname)).toEqual([
      'audit_events_chain_guard',
      'audit_events_immutable',
      'audit_normalize_ip',
    ]);
    for (const r of cfg) expect(String(r.cfg)).toContain(b.sb.schema);

    const head = (
      await b.sb.exec(
        `SELECT "seq"::int AS seq, "hash", "occurredAt" FROM "Audit_Events"`,
      )
    )[0];
    const row = (seq: number, prev: string, at: Date) => {
      const content = {
        seq,
        occurredAt: at,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: String(seq),
        before: null,
        after: null,
        reason: null,
        requestId: null,
        ip: null,
      };
      return { content, hash: computeAuditHash(prev, content) };
    };
    const insert = (r: ReturnType<typeof row>, prev: string) =>
      b.sb.exec(
        `INSERT INTO "${b.sb.schema}"."Audit_Events"
           ("seq","occurredAt","actorType","action","entityType","entityId","hashVersion","prevHash","hash")
         VALUES ($1, $2, 'SYSTEM', 'AUDIT_VERIFIED', 'T', $3, 1, $4, $5)`,
        [r.content.seq, r.content.occurredAt, r.content.entityId, prev, r.hash],
      );
    const back = new Date((head.occurredAt as Date).getTime() - 1500);
    const r2 = row(2, head.hash as string, back);

    // 1. a session with an EMPTY search_path (what pg_dump sets): the trigger still finds its table.
    await b.sb.exec(`SET search_path TO ''`);
    // 2. without the restore flag a backwards pair is rejected, even for the owner.
    expect(
      sqlstate(await insert(r2, head.hash as string).catch((x: unknown) => x)),
    ).toBe('23000');
    // 3. with the flag, the owner can replay it ...
    await b.sb.exec(
      `SELECT set_config('audit.allow_unordered_restore', 'on', false)`,
    );
    await insert(r2, head.hash as string);
    // ... but seq/prevHash continuity stays enforced under the flag.
    const r3bad = row(9, r2.hash, new Date());
    expect(
      sqlstate(await insert(r3bad, r2.hash).catch((x: unknown) => x)),
    ).toBe('23000');
    await b.sb.exec(
      `SELECT set_config('audit.allow_unordered_restore', 'off', false)`,
    );
    const r3 = row(3, r2.hash, new Date(back.getTime() - 1000));
    expect(sqlstate(await insert(r3, r2.hash).catch((x: unknown) => x))).toBe(
      '23000',
    ); // flag off again: still backwards
    await b.sb.exec(`SET search_path TO "${b.sb.schema}", public`);
    const v = await new AuditChainVerifier().verify(b.runner, {
      mode: 'full',
    });
    expect(v).toMatchObject({ ok: true, rows: 2 });
  });

  it('AC2: the application role gets 42501 on UPDATE/DELETE/TRUNCATE, can still SELECT/INSERT; all inside a rolled-back transaction (no role, schema or row survives)', async () => {
    const c = new pg.Client({
      connectionString: (() => {
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        return u.toString();
      })(),
    });
    await c.connect();
    const role = `audit_e2e_${randomUUID().slice(0, 8)}`;
    const schema = `audit_t_${randomUUID().slice(0, 8)}`;
    try {
      const priv = await c.query(
        `SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      if (!priv.rows[0].ok) return; // an owner without CREATEROLE cannot run this check
      await c.query('BEGIN');
      await c.query(`CREATE SCHEMA "${schema}"`);
      await c.query(`SET LOCAL search_path TO "${schema}", public`);
      // What scripts/db-roles.sql sets up: usage + DML by default privileges on the owner's tables.
      await c.query(`CREATE ROLE "${role}" NOLOGIN`);
      await c.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await c.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
      );
      await c.query(withoutTransaction(auditMigrationSql()));
      const hash = computeAuditHash(GENESIS_HASH, {
        seq: 1,
        occurredAt: new Date('2026-11-04T12:00:00.000Z'),
        actorType: 'SYSTEM',
        actorId: null,
        action: 'AUDIT_VERIFIED',
        entityType: 'T',
        entityId: '1',
        before: null,
        after: null,
        reason: null,
        requestId: null,
        ip: null,
      });
      await c.query(
        `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","action","entityType","entityId","prevHash","hash")
         VALUES (1, '2026-11-04T12:00:00.000Z', 'SYSTEM', 'AUDIT_VERIFIED', 'T', '1', $1, $2)`,
        [GENESIS_HASH, hash],
      );
      const attempt = async (
        name: string,
        q: string,
      ): Promise<string | undefined> => {
        await c.query(`SAVEPOINT ${name}`);
        try {
          await c.query(q);
          return undefined;
        } catch (e) {
          return (e as { code?: string }).code;
        } finally {
          await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
        }
      };
      await c.query(`SET LOCAL ROLE "${role}"`);
      expect(
        await attempt('s1', `UPDATE "Audit_Events" SET "reason" = 'x'`),
      ).toBe('42501');
      expect(await attempt('s2', `DELETE FROM "Audit_Events"`)).toBe('42501');
      expect(await attempt('s3', `TRUNCATE "Audit_Events"`)).toBe('42501');
      expect(
        await attempt('s4', `SELECT * FROM "Audit_Events"`),
      ).toBeUndefined();
      expect(
        await attempt(
          's5',
          `ALTER TABLE "Audit_Events" DISABLE ROW LEVEL SECURITY`,
        ),
      ).toBe('42501'); // not the owner: no DDL
      expect(
        await attempt(
          's6',
          `DROP TRIGGER "audit_events_no_update_delete" ON "Audit_Events"`,
        ),
      ).toBe('42501');
      // The Audit_Verifications table (operational) DOES allow UPDATE.
      expect(
        await attempt('s7', `UPDATE "Audit_Verifications" SET "rows" = 1`),
      ).toBeUndefined();
      await c.query('RESET ROLE');
      // PUBLIC has nothing, the owner meets the trigger.
      expect(
        await attempt('s8', `UPDATE "Audit_Events" SET "reason" = 'x'`),
      ).toBe('23000');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      const left = await c.query(
        `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = $1)::int AS r, (SELECT count(*) FROM pg_namespace WHERE nspname = $2)::int AS s`,
        [role, schema],
      );
      expect(left.rows[0]).toEqual({ r: 0, s: 0 });
      await c.end();
    }
  });

  describe('AC8: manipulation is detected (sandbox built WITHOUT the triggers, as a DBA that dropped them)', () => {
    const seed = async (b: Boxed, n: number) => {
      for (let i = 0; i < n; i += 5) {
        await b.audit.transaction(async (_tx, audit) => {
          for (let k = i; k < Math.min(n, i + 5); k++) {
            audit.add({
              actorType: 'ADMIN',
              actorId: randomUUID(),
              action: 'PRODUCT_PRICE_CHANGED',
              entityType: 'PRODUCT',
              entityId: `p-${k}`,
              before: { price: '10.00' },
              after: { price: '11.00' },
            });
          }
        });
      }
    };
    const verify = (
      b: Boxed,
      o: Partial<Parameters<AuditChainVerifier['verify']>[1]> = {},
    ) => new AuditChainVerifier().verify(b.runner, { mode: 'full', ...o });

    it('an altered field is reported at its seq with expected vs found hash', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 30);
      expect((await verify(b)).ok).toBe(true);
      const before = (
        await b.sb.exec(`SELECT "hash" FROM "Audit_Events" WHERE "seq" = 17`)
      )[0].hash as string;
      await b.sb.exec(
        `UPDATE "Audit_Events" SET "after" = '{"price":"1.00"}'::jsonb WHERE "seq" = 17`,
      );
      const r = await verify(b);
      expect(r.ok).toBe(false);
      expect(r.brokenAt).toMatchObject({
        seq: 17,
        reason: 'HASH_MISMATCH',
        found: before,
      });
      expect(r.brokenAt?.expected).toMatch(/^[0-9a-f]{64}$/);
      expect(r.brokenAt?.expected).not.toBe(before);
      expect(r.checkedTo).toBe(16);
    });

    it('a deleted intermediate row is reported as a gap', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 30);
      await b.sb.exec(`DELETE FROM "Audit_Events" WHERE "seq" = 12`);
      const r = await verify(b);
      expect(r.ok).toBe(false);
      expect(r.brokenAt).toMatchObject({
        seq: 12,
        reason: 'SEQ_GAP',
        expected: '12',
        found: '13',
      });
    });

    it('a rewritten hash that is not recomputed, and a broken link, are both caught', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 10);
      await b.sb.exec(
        `UPDATE "Audit_Events" SET "prevHash" = repeat('e', 64) WHERE "seq" = 6`,
      );
      expect((await verify(b)).brokenAt).toMatchObject({
        seq: 6,
        reason: 'PREV_HASH_MISMATCH',
      });
      const b2 = await make({ noTriggers: true });
      await seed(b2, 3);
      await b2.sb.exec(
        `UPDATE "Audit_Events" SET "prevHash" = repeat('e', 64) WHERE "seq" = 1`,
      );
      expect((await verify(b2)).brokenAt).toMatchObject({
        seq: 1,
        reason: 'GENESIS_MISMATCH',
      });
    });

    it('incremental starts at the last OK verification and still catches a rewrite of what was verified', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 20);
      const full = await verify(b);
      expect(full.ok).toBe(true);
      await b.sb.exec(
        `INSERT INTO "Audit_Verifications" ("mode","fromSeq","toSeq","rows","result","headSeq","headHash") VALUES ('full', 1, $1::bigint, $1::int, 'OK', $1::bigint, $2)`,
        [full.lastSeq, full.lastHash],
      );
      await seed(b, 5);
      const inc = await verify(b, { mode: 'incremental' });
      expect(inc).toMatchObject({
        ok: true,
        checkedFrom: 20,
        checkedTo: 25,
        rows: 6,
        done: true,
      });
      // content of the anchor row altered with the same hash => caught (re-hashed)
      await b.sb.exec(
        `UPDATE "Audit_Events" SET "reason" = 'rewritten' WHERE "seq" = 20`,
      );
      expect((await verify(b, { mode: 'incremental' })).brokenAt).toMatchObject(
        { seq: 20, reason: 'HASH_MISMATCH' },
      );
    });

    it('incremental: the anchor row re-hashed with a consistent but DIFFERENT hash, or deleted tail, is caught', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 8);
      const full = await verify(b);
      await b.sb.exec(
        `INSERT INTO "Audit_Verifications" ("mode","fromSeq","toSeq","rows","result","headSeq","headHash") VALUES ('full', 1, 8, 8, 'OK', 8, $1)`,
        [full.lastHash],
      );
      await b.sb.exec(`DELETE FROM "Audit_Events" WHERE "seq" >= 7`); // the verified tail is gone
      expect((await verify(b, { mode: 'incremental' })).ok).toBe(false);
    });

    it('verify is resumable: limit slices walk the chain with nextFromSeq and end done', async () => {
      const b = await make({ noTriggers: true });
      await seed(b, 23);
      let from: number | undefined;
      let total = 0;
      let slices = 0;
      for (;;) {
        const r = await verify(b, { fromSeq: from, limit: 10, batchSize: 4 });
        expect(r.ok).toBe(true);
        total += r.rows;
        slices += 1;
        if (r.done) break;
        expect(r.nextFromSeq).toBe(r.checkedTo + 1);
        from = r.nextFromSeq;
      }
      expect(total).toBe(23);
      expect(slices).toBe(3);
    });

    it('the real database is not touched: no audit_t_ sandbox rows leak into public.Audit_Events', async () => {
      const c = new pg.Client({
        connectionString: (() => {
          const u = new URL(adminDatabaseUrl());
          u.searchParams.delete('schema');
          return u.toString();
        })(),
      });
      await c.connect();
      try {
        const r = await c.query(
          `SELECT to_regclass('public."Audit_Events"') IS NULL AS missing`,
        );
        if (!r.rows[0].missing) {
          const n = await c.query(
            `SELECT count(*)::int AS n FROM public."Audit_Events" WHERE "entityType" IN ('T','ORDER','PRODUCT','RUN','ADMIN_USER')`,
          );
          expect(n.rows[0].n).toBe(0);
        }
      } finally {
        await c.end();
      }
    });
  });
});

describe('the sandbox helper refuses to fall through to public."Audit_Events" (e2e, Story 20.4 follow-up)', () => {
  it('a sandbox that lost its table makes exec() throw instead of reading or writing public', async () => {
    const sb = await createAuditSandbox();
    try {
      // healthy: the helper works and the table is the sandbox's own
      await expect(
        sb.exec(`SELECT count(*)::int AS n FROM "Audit_Events"`),
      ).resolves.toEqual([{ n: 0 }]);
      // the sandbox table disappears (DROP inside the sandbox only)
      await sb.exec(`DROP TABLE "Audit_Events" CASCADE`);
      await expect(
        sb.exec(`SELECT count(*)::int AS n FROM "Audit_Events"`),
      ).rejects.toThrow(/no "Audit_Events" table/);
      await expect(
        sb.exec(`SELECT 1 FROM "Audit_Events" LIMIT 1`),
      ).rejects.toThrow(/Refusing to continue/);
    } finally {
      await sb.drop();
    }
  });
});
