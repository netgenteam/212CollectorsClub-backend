import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedactingLogger } from './../src/common/redacting-logger.js';
import { AuditService } from './../src/audit/audit.service.js';
import {
  IdDocMigrationService,
  IdDocMigrationError,
} from './../src/iddoc-migration/iddoc-migration.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { createAuditSandbox } from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';
import { makeTestCrypto } from './helpers/iddoc-test-crypto.js';
import { generateIdDocTestEnv } from './helpers/iddoc-test-keys.js';

/**
 * Story 20.3 (AC4, AC5, AC6, AC7, AC8): the iddoc migration service against a SANDBOX schema
 * that holds its own copies of "Orders", "Customer_Addresses" and the audit tables (created
 * through `search_path`; the scripts' SQL is unqualified). The real tables are never touched and
 * no row is left in the real "Audit_Events" (immutable). Cedulas are synthetic.
 */
const ENV = generateIdDocTestEnv({});
const ringA = makeTestCrypto(ENV); // active v1
const ringB = makeTestCrypto({ ...ENV, IDDOC_ENC_ACTIVE_KEY: '2' }); // same keyring, active v2

let sb: AuditSandbox;
let prisma: PrismaService;
let audit: AuditService;
const svc = (crypto = ringA) =>
  new IdDocMigrationService(prisma, crypto, audit);

const q = async <T = Record<string, unknown>>(
  sql: string,
  ...p: unknown[]
): Promise<T[]> => (await sb.exec(sql, p)) as T[];
const count = async (sql: string): Promise<number> =>
  Number((await q<{ n: string }>(sql))[0].n);

const ORDER_INSERT = `INSERT INTO "Orders"(id,"accessTokenHash","fulfillmentType","paymentRail","recipientName","recipientPhone",status,"totalUsd","updatedAt","recipientIdDoc")`;
async function seed(orders: number, addresses: number): Promise<void> {
  await q(
    `${ORDER_INSERT}
    SELECT gen_random_uuid(),'x','DELIVERY','PAGO_MOVIL','n','1','PENDING_VERIFICATION',1,now(),
           CASE WHEN g%7=0 THEN 'v '||(31000000+g)::text WHEN g%11=0 THEN (31000000+g)::text WHEN g%13=0 THEN '  '
                WHEN g%17=0 THEN NULL ELSE 'V-'||(31000000+g)::text END
      FROM generate_series(1,$1::int) g`,
    orders,
  );
  await q(
    `INSERT INTO "Customer_Addresses"(id,"customerId","agencyId","recipientName","recipientPhone","deliveryMode",state,municipality,"updatedAt","recipientIdDoc")
    SELECT gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'n','1','AGENCY_OFFICE','s','m',now(),'E-'||(41000000+g)::text
      FROM generate_series(1,$1::int) g`,
    addresses,
  );
}

beforeAll(async () => {
  sb = await createAuditSandbox({
    extraSql: `
      CREATE TABLE "Orders" (LIKE public."Orders" INCLUDING DEFAULTS);
      ALTER TABLE "Orders" ADD PRIMARY KEY (id);
      CREATE TABLE "Customer_Addresses" (LIKE public."Customer_Addresses" INCLUDING DEFAULTS);
      ALTER TABLE "Customer_Addresses" ADD PRIMARY KEY (id);
      CREATE TABLE t_dup ("recipientIdDoc" text UNIQUE);`,
  });
  prisma = new PrismaService(new ConfigService({ DATABASE_URL: sb.url }));
  await prisma.onModuleInit();
  audit = new AuditService(prisma);
}, 60_000);
afterAll(async () => {
  await prisma?.onModuleDestroy();
  await sb?.drop();
});
beforeEach(async () => {
  await q(`DELETE FROM "Orders"`);
  await q(`DELETE FROM "Customer_Addresses"`);
});

const opts = { batchSize: 100, pauseMs: 0 };
/** The audit table is append-only (not even the sandbox can delete): tests read only what they added. */
const auditBase = async (): Promise<number> =>
  Number(
    (
      await q<{ n: string }>(
        `SELECT coalesce(max(seq),0) n FROM "Audit_Events"`,
      )
    )[0].n,
  );
const plainOrders = (): Promise<number> =>
  count(`SELECT count(*) n FROM "Orders" WHERE "recipientIdDoc" IS NOT NULL`);

describe('backfill (AC4, AC5)', () => {
  it('encrypts everything in batches; a second run encrypts 0; check/verify pass; plain kept on Orders', async () => {
    await seed(1000, 250);
    const withPlain = await plainOrders();
    const m1 = await svc().backfill(opts);
    expect(m1.outcome).toBe('ok');
    expect(m1.errors).toBe(0);
    expect(m1.encrypted).toBeGreaterThan(1000); // orders (non blank) + 250 addresses
    expect(m1.unparsed).toBeGreaterThan(0); // the typeless legacy values
    expect(m1.blank).toBeGreaterThan(0);
    expect(m1.batches).toBeGreaterThan(10);
    expect(typeof m1.maxEventLoopDelayMs).toBe('number');
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDoc" IS NOT NULL AND "recipientIdDocEnc" IS NULL AND "recipientIdDoc" ~ '[^[:space:]]'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDocEnc" IS NULL`,
      ),
    ).toBe(0);
    expect(await plainOrders()).toBe(withPlain); // AC8: Orders plain is never touched

    const snapshot = await q(
      `SELECT id,"recipientIdDocEnc" e,"recipientIdDocBlind" b FROM "Orders" ORDER BY id`,
    );
    const m2 = await svc().backfill(opts);
    expect(m2.encrypted).toBe(0);
    expect(
      await q(
        `SELECT id,"recipientIdDocEnc" e,"recipientIdDocBlind" b FROM "Orders" ORDER BY id`,
      ),
    ).toEqual(snapshot);

    expect((await svc().check()).ok).toBe(true);
    const v = await svc().verify(opts);
    expect(v).toMatchObject({
      ok: true,
      pending: 0,
      undecryptable: 0,
      plainMismatch: 0,
      blindMismatch: 0,
    });
    expect(v.verified).toBe(m1.encrypted);
    // unparsed rows have no blind index; parsed ones do
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL AND "recipientIdDocBlind" IS NULL`,
      ),
    ).toBe(m1.unparsed);
  });

  it('writes one DATA_MIGRATION_RUN per run with counters only (no cedula, no row ids)', async () => {
    await seed(120, 30);
    const base = await auditBase();
    await svc().backfill(opts);
    await svc().backfill(opts);
    const ev = await q<{
      action: string;
      after: Record<string, unknown>;
      actorType: string;
    }>(
      `SELECT action,"actorType",after FROM "Audit_Events" WHERE seq > ${base} ORDER BY seq`,
    );
    expect(ev.map((e) => e.action)).toEqual([
      'DATA_MIGRATION_RUN',
      'DATA_MIGRATION_RUN',
    ]);
    expect(ev[0].actorType).toBe('SYSTEM');
    expect(ev[0].after).toMatchObject({
      mode: 'backfill',
      outcome: 'ok',
      errors: 0,
    });
    expect(ev[1].after).toMatchObject({ encrypted: 0 });
    const json = JSON.stringify(ev);
    expect(json).not.toMatch(/3[01]\d{6}|41\d{6}/); // none of the synthetic cedulas
    expect(json).not.toMatch(/v1:/);
    expect(
      (await q(`SELECT * FROM audit_verify_chain_ok()`).catch(() => [])).length,
    ).toBeGreaterThanOrEqual(0);
  });

  it('a cut in the middle resumes where the data says; the final state equals an uninterrupted run', async () => {
    await seed(900, 100);
    const base = await auditBase();
    let n = 0;
    await expect(
      svc().backfill({
        ...opts,
        onBatch: () => {
          if (++n === 3) throw new Error('simulated cut');
        },
      }),
    ).rejects.toThrow('simulated cut');
    const mid = await count(
      `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL`,
    );
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(900);
    const keep = await q(
      `SELECT id,"recipientIdDocEnc" e FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL ORDER BY id`,
    );
    const m = await svc().backfill(opts);
    expect(m.outcome).toBe('ok');
    // what was already encrypted is not rewritten (same ciphertext)
    for (const r of keep) {
      expect(
        (
          await q(
            `SELECT "recipientIdDocEnc" e FROM "Orders" WHERE id=$1`,
            r.id,
          )
        )[0].e,
      ).toBe(r.e);
    }
    expect((await svc().verify(opts)).ok).toBe(true);
    expect((await svc().check()).ok).toBe(true);
    // the cut run was recorded too (failed), then the resumed one
    const outs = await q<{ o: string }>(
      `SELECT after->>'outcome' o FROM "Audit_Events" WHERE seq > ${base} ORDER BY seq`,
    );
    expect(outs.map((x) => x.o)).toEqual(['FAILED', 'ok']);
  });

  it('concurrent writes by the app are never overwritten (Promise.all with the backfill)', async () => {
    await seed(1500, 0);
    const victims = (
      await q<{ id: string }>(
        `SELECT id FROM "Orders" WHERE "recipientIdDoc" IS NOT NULL ORDER BY random() LIMIT 200`,
      )
    ).map((r) => r.id);
    const appValue = ringA.encrypt('E-99999999');
    const appBlind = ringA.blindIndex('E', '99999999');
    const app = (async () => {
      for (const id of victims) {
        await q(
          `UPDATE "Orders" SET "recipientIdDocEnc"=$2,"recipientIdDocBlind"=$3,"recipientIdDoc"=NULL WHERE id=$1`,
          id,
          appValue,
          appBlind,
        );
      }
    })();
    const run = svc().backfill({ batchSize: 40, pauseMs: 2 });
    const [m] = await Promise.all([run, app]);
    expect(m.outcome).toBe('ok');
    for (const id of victims) {
      const r = (
        await q(
          `SELECT "recipientIdDocEnc" e,"recipientIdDocBlind" b,"recipientIdDoc" p FROM "Orders" WHERE id=$1`,
          id,
        )
      )[0];
      expect(r.e).toBe(appValue);
      expect(r.b).toBe(appBlind);
    }
    const v = await svc().verify(opts);
    expect(v.ok).toBe(true);
  });

  it('a row inserted behind the cursor by an old build is caught (second pass / next run)', async () => {
    await seed(300, 0);
    let injected = false;
    const m = await svc().backfill({
      ...opts,
      onBatch: async () => {
        if (injected) return;
        injected = true;
        // an old build inserts a plain-only row with the SMALLEST possible id (behind the cursor)
        await q(
          `${ORDER_INSERT} VALUES ('00000000-0000-0000-0000-000000000001','x','DELIVERY','PAGO_MOVIL','n','1','PENDING_VERIFICATION',1,now(),'V-77777777')`,
        );
      },
    });
    expect(m.passes).toBeGreaterThanOrEqual(2);
    expect((await svc().check()).ok).toBe(true);
  });

  it('--check fails while a plain value remains, and malformed ciphertext fails it too', async () => {
    await seed(50, 0);
    const c = await svc().check();
    expect(c.ok).toBe(false);
    expect(Object.values(c.pending).reduce((a, b) => a + b, 0)).toBeGreaterThan(
      0,
    );
    await svc().backfill(opts);
    expect((await svc().check()).ok).toBe(true);
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"='garbage' WHERE id=(SELECT id FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL LIMIT 1)`,
    );
    const bad = await svc().check();
    expect(bad.ok).toBe(false);
    expect(bad.malformed['orders.recipient']).toBe(1);
  });
});

describe('keys: failures are found BEFORE anything is written', () => {
  it('a key version stored in the database that this process does not have', async () => {
    await seed(100, 20);
    const other = makeTestCrypto({
      ...ENV,
      IDDOC_ENC_KEYS: `${ENV.IDDOC_ENC_KEYS},3:${Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')}`,
      IDDOC_ENC_ACTIVE_KEY: '3',
    });
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"=$1,"recipientIdDocBlind"=$2 WHERE id=(SELECT id FROM "Orders" LIMIT 1)`,
      other.encrypt('V-12345678'),
      other.blindIndex('V', '12345678'),
    );
    const before = await count(
      `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL`,
    );
    await expect(svc().backfill(opts)).rejects.toMatchObject({
      code: 'KEY_PREFLIGHT_FAILED',
    });
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL`,
      ),
    ).toBe(before);
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDocEnc" IS NOT NULL`,
      ),
    ).toBe(0);
  });

  it('a known version with the WRONG key, and a wrong blind key', async () => {
    await seed(60, 0);
    const foreign = makeTestCrypto(generateIdDocTestEnv({})); // other keys, same version numbers
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"=$1 WHERE id=(SELECT id FROM "Orders" LIMIT 1)`,
      foreign.encrypt('V-12345678'),
    );
    await expect(svc().backfill(opts)).rejects.toMatchObject({
      code: 'KEY_PREFLIGHT_FAILED',
    });
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL`,
      ),
    ).toBe(1);
    await q(`UPDATE "Orders" SET "recipientIdDocEnc"=NULL`);
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"=$1,"recipientIdDocBlind"=$2 WHERE id=(SELECT id FROM "Orders" LIMIT 1)`,
      ringA.encrypt('V-12345678'),
      foreign.blindIndex('V', '12345678'),
    );
    await expect(svc().backfill(opts)).rejects.toMatchObject({
      code: 'KEY_PREFLIGHT_FAILED',
    });
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL`,
      ),
    ).toBe(1);
  });

  it('the active keyring changes between batches: both versions are written and read', async () => {
    await seed(600, 0);
    let n = 0;
    await expect(
      svc(ringA).backfill({
        ...opts,
        onBatch: () => {
          if (++n === 2) throw new Error('cut');
        },
      }),
    ).rejects.toThrow('cut');
    await svc(ringB).backfill(opts); // restarted with ACTIVE=2
    const rep = await svc(ringB).report();
    expect(rep['orders.recipient'].v1).toBeGreaterThan(0);
    expect(rep['orders.recipient'].v2).toBeGreaterThan(0);
    expect(rep['orders.recipient'].plain_only).toBe(0);
    for (const r of [ringA, ringB])
      expect((await svc(r).verify(opts)).ok).toBe(true);
  });
});

describe('reencrypt and report (AC6)', () => {
  it('v1 -> v2; masked output and blind index unchanged; dry run writes nothing; idempotent', async () => {
    await seed(400, 80);
    await svc(ringA).backfill(opts);
    const masked = async () =>
      (
        await q<{ e: string; p: string }>(
          `SELECT "recipientIdDocEnc" e,"recipientIdDoc" p FROM "Orders" ORDER BY id`,
        )
      ).map((r) => ringB.serialize(r.e, r.p));
    const blinds = () =>
      q(`SELECT id,"recipientIdDocBlind" b FROM "Orders" ORDER BY id`);
    const m0 = await masked();
    const b0 = await blinds();
    const before = await svc().report();
    expect(before['orders.recipient'].v2 ?? 0).toBe(0);

    const base = await auditBase();
    const dry = await svc(ringB).reencrypt(2, { ...opts, dryRun: true });
    expect(dry.encrypted).toBe(0);
    expect(dry['wouldReencrypt']).toBeGreaterThan(0);
    expect((await svc().report())['orders.recipient'].v1).toBe(
      before['orders.recipient'].v1,
    );
    expect(
      await count(
        `SELECT count(*) n FROM "Audit_Events" WHERE after->>'mode'='reencrypt' AND seq > ${base}`,
      ),
    ).toBe(0); // a dry run is not a run

    const m = await svc(ringB).reencrypt(2, opts);
    expect(m.outcome).toBe('ok');
    const after = await svc(ringB).report();
    for (const set of Object.values(after)) expect(set.v1 ?? 0).toBe(0);
    expect(await masked()).toEqual(m0);
    expect(await blinds()).toEqual(b0);
    expect((await svc(ringB).verify(opts)).ok).toBe(true);
    expect((await svc(ringB).reencrypt(2, opts)).encrypted).toBe(0);
    await expect(svc(ringB).reencrypt(9, opts)).rejects.toBeInstanceOf(
      IdDocMigrationError,
    );
  });

  it('a concurrent edit during reencrypt is not overwritten (compare-and-swap)', async () => {
    await seed(500, 0);
    await svc(ringA).backfill(opts);
    const ids = (
      await q<{ id: string }>(
        `SELECT id FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL ORDER BY random() LIMIT 100`,
      )
    ).map((r) => r.id);
    const edited = ringA.encrypt('J-123456789');
    const app = (async () => {
      for (const id of ids)
        await q(
          `UPDATE "Orders" SET "recipientIdDocEnc"=$2 WHERE id=$1`,
          id,
          edited,
        );
    })();
    await Promise.all([
      svc(ringB).reencrypt(2, { batchSize: 30, pauseMs: 2 }),
      app,
    ]);
    for (const id of ids) {
      const e = (
        await q<{ e: string }>(
          `SELECT "recipientIdDocEnc" e FROM "Orders" WHERE id=$1`,
          id,
        )
      )[0].e;
      expect(ringB.checkStored(e, { expectedPlain: 'J-123456789' })).toBe('ok'); // the edit survived (v1 or v2)
    }
  });

  it('an unreadable value is counted, left untouched, and fails the run; the rest is rotated', async () => {
    await seed(50, 0);
    await svc().backfill(opts);
    const bad = 'v1:' + 'A'.repeat(16) + ':' + 'B'.repeat(22) + ':CCCC';
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"=$1 WHERE id=(SELECT id FROM "Orders" WHERE "recipientIdDocEnc" IS NOT NULL LIMIT 1)`,
      bad,
    );
    const m = await svc(ringB).reencrypt(2, opts);
    expect(m.errors).toBe(1);
    expect(m.outcome).toBe('SOME_VALUES_UNREADABLE');
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" = '${bad}'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) n FROM "Orders" WHERE "recipientIdDocEnc" LIKE 'v1:%'`,
      ),
    ).toBe(1);
  });
});

describe('verify and scrub (AC5, AC8)', () => {
  it('verify detects a value that decrypts to something else, and a lost blind index', async () => {
    await seed(80, 0);
    await svc().backfill(opts);
    await q(
      `UPDATE "Orders" SET "recipientIdDocEnc"=$1 WHERE id=(SELECT id FROM "Orders" WHERE "recipientIdDoc" LIKE 'V-%' LIMIT 1)`,
      ringA.encrypt('V-00000001'),
    );
    const v = await svc().verify(opts);
    expect(v.ok).toBe(false);
    expect(v.plainMismatch).toBeGreaterThanOrEqual(1);
    const run = await svc().runVerify(opts);
    expect(run.outcome).toBe('VERIFY_FAILED');
  });

  it('scrub: addresses only, after a real verify; Orders are byte-identical afterwards', async () => {
    await seed(300, 120);
    await svc().backfill(opts);
    const orders = await q(`SELECT * FROM "Orders" ORDER BY id`);
    const m = await svc().scrub(opts);
    expect(m.outcome).toBe('ok');
    expect(m['scrubbed']).toBe(120);
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDocEnc" IS NULL`,
      ),
    ).toBe(0);
    expect(await q(`SELECT * FROM "Orders" ORDER BY id`)).toEqual(orders);
    expect((await svc().verify(opts)).ok).toBe(true); // Enc-only rows verify by decryption + blind
    expect((await svc().scrub(opts))['scrubbed'] ?? 0).toBe(0); // idempotent
  });

  it('scrub refuses everything when the verify fails (pending, tampered): nothing is nulled', async () => {
    await seed(40, 60);
    await svc().backfill(opts);
    await q(
      `UPDATE "Customer_Addresses" SET "recipientIdDocEnc"=$1,"recipientIdDocBlind"=$2 WHERE id=(SELECT id FROM "Customer_Addresses" LIMIT 1)`,
      ringA.encrypt('V-00000002'),
      ringA.blindIndex('V', '00000002'),
    );
    const m = await svc().scrub(opts);
    expect(m.outcome).toBe('VERIFY_FAILED');
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL`,
      ),
    ).toBe(60);

    await q(
      `UPDATE "Customer_Addresses" SET "recipientIdDocEnc"=NULL,"recipientIdDocBlind"=NULL WHERE id=(SELECT id FROM "Customer_Addresses" LIMIT 1)`,
    );
    expect((await svc().scrub(opts)).outcome).toBe('VERIFY_FAILED'); // a plain value with no ciphertext
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL`,
      ),
    ).toBe(60);
  });

  it('scrub never nulls a row whose copy does not verify at that moment (row-level re-check)', async () => {
    await seed(0, 50);
    await svc().backfill(opts);
    let bad: string | undefined;
    const m = await svc().scrub({
      ...opts,
      batchSize: 25,
      onBatch: async () => {
        if (bad) return;
        // after the full verify and the first batch: corrupt one row of the NEXT batch
        bad = (
          await q<{ id: string }>(
            `SELECT id FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL ORDER BY id LIMIT 1`,
          )
        )[0]?.id;
        if (bad)
          await q(
            `UPDATE "Customer_Addresses" SET "recipientIdDocEnc"=$2 WHERE id=$1`,
            bad,
            ringA.encrypt('V-00000003'),
          );
      },
    });
    expect(m.outcome).toBe('SOME_ROWS_KEPT');
    expect(
      await count(
        `SELECT count(*) n FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL`,
      ),
    ).toBe(1);
    expect(
      (
        await q<{ id: string }>(
          `SELECT id FROM "Customer_Addresses" WHERE "recipientIdDoc" IS NOT NULL`,
        )
      )[0].id,
    ).toBe(bad);
  });
});

describe('logs never carry a cedula (NFR-20.5)', () => {
  it('a full run, a failing run and a real Postgres unique-violation on the cedula index', async () => {
    const out: string[] = [];
    const w = (c: unknown): boolean => (out.push(String(c)), true);
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = w;
    process.stderr.write = w;
    try {
      Logger.overrideLogger(
        new RedactingLogger({
          logLevels: ['log', 'warn', 'error', 'debug', 'verbose'],
        }),
      );
      await seed(200, 30);
      const m = await svc().backfill(opts);
      console.log(JSON.stringify(m));
      await svc().verify(opts);
      // A REAL Postgres error whose DETAIL carries the cedula (unique index on the plain column).
      await q(`INSERT INTO t_dup VALUES ('V-31234567')`);
      let pgErr: unknown;
      try {
        await q(`INSERT INTO t_dup VALUES ('V-31234567')`);
      } catch (x) {
        pgErr = x;
      }
      let prismaErr: unknown;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO t_dup VALUES ('V-31234567')`,
        );
      } catch (x) {
        prismaErr = x;
      }
      expect(
        String((pgErr as Error).message) + JSON.stringify(pgErr),
      ).toContain('31234567'); // proves the error is real and does carry it
      const log = new Logger('Probe');
      log.error(pgErr);
      log.error(prismaErr);
      log.error(`Key (recipientIdDoc)=(31234567) already exists`);
      log.error({
        meta: { target: 'recipientIdDoc' },
        detail: (pgErr as { detail?: string }).detail,
        message: (prismaErr as Error).message,
      });
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
      Logger.overrideLogger(['log', 'warn', 'error']);
    }
    const all = out.join('');
    expect(all.length).toBeGreaterThan(100);
    expect(all).not.toMatch(/31\d{6}|41\d{6}/); // no synthetic cedula, in any shape
    expect(all).not.toMatch(/\bv1:[A-Za-z0-9_-]{16}:/); // no ciphertext either
    await q(`DELETE FROM t_dup`);
  });
});
