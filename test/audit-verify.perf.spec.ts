import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { PrismaClient } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import { AuditService } from './../src/audit/audit.service.js';
import {
  GENESIS_HASH,
  computeAuditHash,
} from './../src/audit/canonical-json.js';
import { createAuditSandbox } from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';

/**
 * Story 20.1, perf (pnpm test:perf, one file at a time, quiet machine):
 *  (1) POST /admin/audit/verify over 200.000 rows must not freeze the event
 *      loop (two QA rejections in Epics 18/19 were exactly this) and must reach
 *      >= 50.000 rows/min (NFR-20.3);
 *  (2) cost of the chain-head lock under concurrent transactions.
 * Both on SANDBOX schemas; the real Audit_Events is never touched.
 * Timings use the monotonic clock (the WSL2 wall clock steps back).
 */
const ROWS = Number(process.env.AUDIT_PERF_ROWS ?? 200_000);
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-auditperf-${TAG}`;
const PASS = 'correct-horse-battery-staple-20-1p';

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function bulkInsert(sb: AuditSandbox, n: number): Promise<void> {
  let prev = GENESIS_HASH;
  const base = Date.parse('2026-11-04T00:00:00.000Z');
  const CHUNK = 5_000;
  for (let from = 1; from <= n; from += CHUNK) {
    const rows: Record<string, unknown>[] = [];
    for (let seq = from; seq < Math.min(n + 1, from + CHUNK); seq++) {
      const at = new Date(base + seq * 7);
      const ev = {
        seq,
        occurredAt: at,
        actorType: 'ADMIN',
        actorId: '0b8f2f0e-6d2c-4f43-9a3e-7c1d2e3f4a5b',
        action: 'ORDER_STATUS_CHANGED',
        entityType: 'ORDER',
        entityId: `order-${seq}`,
        before: { status: 'PAID', total: '120.50', items: 3 },
        after: {
          status: 'SHIPPED',
          total: '120.50',
          items: 3,
          tracking: `T${seq}`,
        },
        reason: seq % 10 === 0 ? 'manual change by admin' : null,
        requestId: '11111111-1111-4111-8111-111111111111',
        ip: '203.0.113.7',
      };
      const hash = computeAuditHash(prev, ev);
      rows.push({ ...ev, occurredAt: at.toISOString(), prevHash: prev, hash });
      prev = hash;
    }
    await sb.exec(
      `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","actorId","action","entityType","entityId","before","after","reason","requestId","ip","hashVersion","prevHash","hash")
       SELECT x.seq, x."occurredAt", x."actorType", x."actorId", x.action, x."entityType", x."entityId", x.before, x.after, x.reason, x."requestId", x.ip::inet, 1, x."prevHash", x.hash
         FROM jsonb_to_recordset($1::jsonb) AS x(seq bigint, "occurredAt" timestamptz, "actorType" text, "actorId" uuid, action text, "entityType" text, "entityId" text, before jsonb, after jsonb, reason text, "requestId" uuid, ip text, "prevHash" text, hash text)`,
      [JSON.stringify(rows)],
    );
  }
}

describe('audit verification does not block the event loop (perf, Story 20.1)', () => {
  let sb: AuditSandbox;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  const savedUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    sb = await createAuditSandbox({});
    const t0 = nowMs();
    await bulkInsert(sb, ROWS);
    console.log(`[perf] seeded ${ROWS} rows in ${Math.round(nowMs() - t0)} ms`);
    process.env.DATABASE_URL = sb.url;
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    applyRequestContext(app);
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.adminUser.upsert({
      where: { username: USER },
      create: {
        username: USER,
        email: `${USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
      update: {},
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  }, 300_000);

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    await sb.drop();
  });

  it(`POST /admin/audit/verify { mode: full, limit: ${ROWS} }: event-loop delay and throughput`, async () => {
    const histo = monitorEventLoopDelay({ resolution: 1 });
    // Independent probe: a timer that asks "how late am I?" every 5 ms.
    let maxLate = 0;
    let last = nowMs();
    const probe = setInterval(() => {
      const t = nowMs();
      maxLate = Math.max(maxLate, t - last - 5);
      last = t;
    }, 5);
    histo.enable();
    const t0 = nowMs();
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/audit/verify')
      .set({ Authorization: `Bearer ${token}` })
      .send({ mode: 'full', limit: ROWS })
      .expect(200);
    const ms = nowMs() - t0;
    histo.disable();
    clearInterval(probe);
    const body = res.body as { ok: boolean; rows: number; done: boolean };
    expect(body).toMatchObject({ ok: true, rows: ROWS, done: true });
    const perMin = Math.round((ROWS / ms) * 60_000);
    console.log(
      `[perf] verify ${ROWS} rows in ${Math.round(ms)} ms = ${perMin} rows/min; event-loop delay: mean ${(histo.mean / 1e6).toFixed(1)} ms, p99 ${(histo.percentile(99) / 1e6).toFixed(1)} ms, max ${(histo.max / 1e6).toFixed(1)} ms; timer probe max lateness ${maxLate.toFixed(1)} ms`,
    );
    expect(perMin).toBeGreaterThanOrEqual(50_000);
    expect(histo.max / 1e6).toBeLessThan(100);
    expect(maxLate).toBeLessThan(100);
  }, 600_000);

  it('verifier alone (slices of 250 rows) vs. one single un-sliced pass: why the yield exists', async () => {
    const runner = (sql: string, params: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    const measure = async (sliceRows: number) => {
      const histo = monitorEventLoopDelay({ resolution: 1 });
      histo.enable();
      const t0 = nowMs();
      const r = await new AuditChainVerifier().verify(runner, {
        mode: 'full',
        limit: ROWS,
        sliceRows,
      });
      const ms = nowMs() - t0;
      histo.disable();
      expect(r.ok).toBe(true);
      return { ms: Math.round(ms), maxMs: histo.max / 1e6 };
    };
    const sliced = await measure(250);
    const unsliced = await measure(10_000_000);
    console.log(
      `[perf] verifier sliced(250): ${sliced.ms} ms, max loop delay ${sliced.maxMs.toFixed(1)} ms | un-sliced: ${unsliced.ms} ms, max loop delay ${unsliced.maxMs.toFixed(1)} ms`,
    );
    expect(sliced.maxMs).toBeLessThan(100);
  }, 600_000);
});

describe('cost of the chain-head lock under concurrent transactions (perf, Story 20.1)', () => {
  let sb: AuditSandbox;
  let client: PrismaClient;
  let audit: AuditService;
  const PRODUCTS = 500;

  beforeAll(async () => {
    sb = await createAuditSandbox({
      extraSql: `
        CREATE TABLE prod_t (id int PRIMARY KEY, stock int NOT NULL);
        INSERT INTO prod_t SELECT g, 1000000 FROM generate_series(1, ${PRODUCTS}) g;
        CREATE TABLE ord_t (id bigserial PRIMARY KEY, pid int NOT NULL, qty int NOT NULL, at timestamptz DEFAULT now());
        CREATE TABLE item_t (id bigserial PRIMARY KEY, oid bigint NOT NULL, pid int NOT NULL);
      `,
    });
    // Pool of 30 so concurrency 25 is possible (the app's default pool is 10).
    const adapter = new PrismaPg({ connectionString: sb.url, max: 30 });
    client = new PrismaClient({ adapter });
    await client.$connect();
    audit = new AuditService(client as unknown as PrismaService);
  }, 120_000);

  afterAll(async () => {
    await client.$disconnect();
    await sb.drop();
  });

  /** A checkout-shaped transaction: lock 2 product rows, decrement stock, insert an order and 2 items (+ optional audit as the LAST step). */
  const checkoutTx = (withAudit: boolean, i: number) => {
    const a = 1 + ((i * 7) % PRODUCTS);
    const b = 1 + ((i * 13 + 5) % PRODUCTS);
    const [p1, p2] = a < b ? [a, b] : [b, a === b ? (b % PRODUCTS) + 1 : a];
    const body = async (
      tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    ) => {
      await tx.$queryRaw`SELECT id FROM prod_t WHERE id IN (${p1}, ${p2}) ORDER BY id FOR UPDATE`;
      await tx.$executeRaw`UPDATE prod_t SET stock = stock - 1 WHERE id IN (${p1}, ${p2})`;
      const o = await tx.$queryRaw<
        { id: bigint }[]
      >`INSERT INTO ord_t (pid, qty) VALUES (${p1}, 1) RETURNING id`;
      await tx.$executeRaw`INSERT INTO item_t (oid, pid) VALUES (${o[0].id}, ${p1}), (${o[0].id}, ${p2})`;
    };
    if (!withAudit)
      return client.$transaction(body, { timeout: 30_000, maxWait: 30_000 });
    return audit.transaction(async (tx, a2) => {
      await body(tx);
      a2.add({
        actorType: 'CUSTOMER',
        actorId: randomUUID(),
        action: 'PAYMENT_PAGO_MOVIL_CONFIRMED',
        entityType: 'ORDER',
        entityId: `o-${i}`,
        before: { status: 'PENDING_VERIFICATION' },
        after: { status: 'PAID', total: '120.50' },
      });
    });
  };

  const run = async (
    withAudit: boolean,
    concurrency: number,
    total: number,
  ) => {
    const lat: number[] = [];
    let next = 0;
    const t0 = nowMs();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < total) {
          const i = next++;
          const s = nowMs();
          await checkoutTx(withAudit, i);
          lat.push(nowMs() - s);
        }
      }),
    );
    const secs = (nowMs() - t0) / 1000;
    return {
      tps: total / secs,
      p50: pct(lat, 50),
      p95: pct(lat, 95),
      p99: pct(lat, 99),
      max: Math.max(...lat),
    };
  };

  it('measures throughput and latency with and without the audit lock (1, 5, 10 and 25 concurrent transactions)', async () => {
    await run(false, 5, 100); // warm-up
    await run(true, 5, 100);
    const f = (n: number) => n.toFixed(1);
    const lines: string[] = [];
    for (const conc of [1, 5, 10, 25]) {
      const total = conc === 1 ? 300 : 600;
      const base = await run(false, conc, total);
      const aud = await run(true, conc, total);
      lines.push(
        `[perf] conc=${conc}: WITHOUT audit ${f(base.tps)} tx/s p50 ${f(base.p50)} p95 ${f(base.p95)} p99 ${f(base.p99)} max ${f(base.max)} ms | WITH audit ${f(aud.tps)} tx/s p50 ${f(aud.p50)} p95 ${f(aud.p95)} p99 ${f(aud.p99)} max ${f(aud.max)} ms`,
      );
      expect(aud.max).toBeLessThan(5_000); // never reaches the 5 s lock budget at these rates
    }
    console.log(lines.join('\n'));
    const n = await sb.exec(
      `SELECT count(*)::int AS n, max("seq")::int AS mx FROM "Audit_Events"`,
    );
    expect(n[0].n).toBe(n[0].mx); // gapless
    const v = await new AuditChainVerifier().verify(
      (sql, p = []) =>
        client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...p),
      { mode: 'full' },
    );
    expect(v.ok).toBe(true);
  }, 300_000);
});
