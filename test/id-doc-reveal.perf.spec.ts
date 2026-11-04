/* eslint-disable @typescript-eslint/unbound-method -- the lock-hold probe patches LockBudget.prototype.release and puts it back */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AuditService } from './../src/audit/audit.service.js';
import { LockBudget } from './../src/common/lock-timeout.js';
import { createAuditSandbox } from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';
import { appCrypto } from './helpers/iddoc-assert.js';

/**
 * Story 20.4, perf (pnpm test:perf, one file at a time, quiet machine):
 *  (1) the hourly-limit COUNT that runs inside the audit chain lock must use the indexes and
 *      stay in the low milliseconds on a big `Audit_Events` (it is work done under a lock every
 *      other audited action queues behind);
 *  (2) how long the reveal transaction really HOLDS the chain lock, against a plain one-event
 *      audited transaction on the same table (the difference is the cost of the count).
 * SANDBOX schema WITHOUT triggers (rows are bulk-seeded with generate_series; the chain is not
 * under test); the real Audit_Events is never touched. Monotonic clock.
 */
const ROWS = Number(process.env.REVEAL_PERF_ROWS ?? 1_000_000);
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-revealperf-${TAG}`;
const PASS = 'correct-horse-battery-staple-20-4p';
const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

describe('reveal limit count and chain-lock hold (perf, Story 20.4)', () => {
  let sb: AuditSandbox;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let base: string;
  let adminId: string;
  let token: string;
  let orderId: string;
  let savedUrl: string | undefined;
  const savedMax = process.env.ID_DOC_REVEAL_MAX_PER_HOUR;

  // Lock-hold instrumentation: the FIRST LockBudget.release() of a transaction is the instant the
  // chain lock was acquired (both the reveal and AuditService.flush call it right after the lock);
  // the transaction's end is the instant the lock is released.
  const store = new AsyncLocalStorage<{ acquired?: number }>();
  const held: { reveal: number[]; baseline: number[] } = {
    reveal: [],
    baseline: [],
  };
  let mode: 'reveal' | 'baseline' = 'reveal';
  const undo: (() => void)[] = [];

  beforeAll(async () => {
    sb = await createAuditSandbox({ noTriggers: true });
    const t0 = nowMs();
    // ~1 event per 2 s up to now; a reveal every 500th row spread over 3 admins; ~1800 rows in the last hour.
    await sb.exec(
      `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","actorId","action","entityType","entityId","hashVersion","prevHash","hash")
       SELECT g, date_trunc('milliseconds', clock_timestamp()) - ($1::bigint - g) * interval '2 seconds',
              'ADMIN',
              ('00000000-0000-4000-8000-' || lpad((g % 3)::text, 12, '0'))::uuid,
              CASE WHEN g % 500 = 0 THEN 'ID_DOC_REVEALED' ELSE 'ORDER_STATUS_CHANGED' END,
              'Order', 'e-' || g, 1, repeat('0', 64),
              md5(g::text) || md5(g::text || 'x')
         FROM generate_series(1, $1::bigint) g`,
      [ROWS],
    );
    await sb.exec(`ANALYZE "Audit_Events"`);
    console.log(`[perf] seeded ${ROWS} rows in ${Math.round(nowMs() - t0)} ms`);

    savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = sb.url;
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    applyRequestContext(app);
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    prisma = app.get(PrismaService);
    const hash = await argon2.hash(PASS, { type: argon2.argon2id });
    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: `${USER}@212collectorsclub.test`,
        passwordHash: hash,
      },
    });
    adminId = admin.id;
    const login = await request(base)
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    const p = appCrypto.protect('V-91234567');
    const o = await prisma.order.create({
      data: {
        status: 'PENDING_VERIFICATION',
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'DELIVERY',
        recipientName: 'Perf Tester',
        recipientPhone: '04121234567',
        totalUsd: '5.00',
        accessTokenHash: randomUUID(),
        recipientIdDocEnc: p?.enc,
        recipientIdDocBlind: p?.blind,
      },
    });
    orderId = o.id;

    // Instrumentation.
    const origRelease = LockBudget.prototype.release;
    LockBudget.prototype.release = async function (this: LockBudget) {
      await origRelease.call(this);
      const s = store.getStore();
      if (s && s.acquired === undefined) s.acquired = nowMs();
    };
    undo.push(() => {
      LockBudget.prototype.release = origRelease;
    });
    const origTx = prisma.$transaction.bind(prisma) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    (prisma as unknown as { $transaction: unknown }).$transaction = (
      ...a: unknown[]
    ) =>
      store.run({}, async () => {
        try {
          return await origTx(...a);
        } finally {
          const s = store.getStore();
          if (s?.acquired !== undefined) held[mode].push(nowMs() - s.acquired);
        }
      });
    undo.push(() => {
      (prisma as unknown as { $transaction: unknown }).$transaction = origTx;
    });
  }, 300_000);

  afterAll(async () => {
    for (const u of undo.reverse()) u();
    if (savedMax === undefined) delete process.env.ID_DOC_REVEAL_MAX_PER_HOUR;
    else process.env.ID_DOC_REVEAL_MAX_PER_HOUR = savedMax;
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    await sb.drop();
  });

  it('the count uses the indexes (no sequential scan) and is fast on a big table', async () => {
    const q = `
      WITH "w" AS (
        SELECT "seq" FROM "Audit_Events"
         WHERE "occurredAt" > statement_timestamp() - interval '1 hour'
         ORDER BY "occurredAt" ASC, "seq" ASC LIMIT 1
      )
      SELECT count(*)::int AS "n",
             extract(epoch FROM (min("occurredAt") + interval '1 hour' - statement_timestamp()))::float8 AS "wait"
        FROM "Audit_Events"
       WHERE "action" = 'ID_DOC_REVEALED'
         AND "seq" >= COALESCE((SELECT "seq" FROM "w"), 9223372036854775807)
         AND "actorId" = '00000000-0000-4000-8000-000000000001'::uuid
         AND "occurredAt" > statement_timestamp() - interval '1 hour'`;
    const times: number[] = [];
    let plan = '';
    for (let i = 0; i < 25; i++) {
      const rows = await sb.exec(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}`,
      );
      plan = rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      const m = /Execution Time: ([0-9.]+) ms/.exec(plan);
      times.push(Number(m?.[1]));
    }
    console.log(
      `[perf] reveal count over ${ROWS} rows: p50 ${pct(times, 50).toFixed(2)} ms, p95 ${pct(times, 95).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`,
    );
    console.log(`[perf] plan:\n${plan}`);
    expect(plan).not.toMatch(/Seq Scan on "?Audit_Events/);
    expect(plan).toMatch(/Audit_Events_action_seq_idx/);
    expect(plan).toMatch(/Audit_Events_occurredAt_idx/);
    expect(pct(times, 95)).toBeLessThan(25);
  }, 120_000);

  it('how long the chain lock is HELD: reveal (count + event) vs a plain one-event audited transaction, 31 concurrent', async () => {
    process.env.ID_DOC_REVEAL_MAX_PER_HOUR = '100000';
    const audit = app.get(AuditService);
    const runBaseline = async (n: number): Promise<number> => {
      mode = 'baseline';
      const t0 = nowMs();
      await Promise.all(
        Array.from({ length: n }, () =>
          audit.transaction(async (_tx, a) => {
            a.add({
              actorType: 'ADMIN',
              actorId: adminId,
              action: 'ORDER_STATUS_CHANGED',
              entityType: 'Order',
              entityId: orderId,
              after: { n: 1 },
            });
            return Promise.resolve();
          }),
        ),
      );
      return nowMs() - t0;
    };
    const runReveal = async (
      n: number,
    ): Promise<{ ms: number; statuses: number[] }> => {
      mode = 'reveal';
      const t0 = nowMs();
      const rs = await Promise.all(
        Array.from({ length: n }, () =>
          request(base)
            .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
            .set('Authorization', `Bearer ${token}`)
            .send({ field: 'recipient' }),
        ),
      );
      return { ms: nowMs() - t0, statuses: rs.map((r) => r.status) };
    };
    await runBaseline(5); // warm up (pool, ip cache, plans)
    await runReveal(5);
    held.baseline.length = 0;
    held.reveal.length = 0;

    const baseMs = await runBaseline(31);
    const rev = await runReveal(31);
    expect(rev.statuses.every((s) => s === 200)).toBe(true);
    console.log(
      `[perf] 31 concurrent plain audited tx: wall ${baseMs.toFixed(0)} ms; lock held p50 ${pct(held.baseline, 50).toFixed(1)} ms, p95 ${pct(held.baseline, 95).toFixed(1)} ms, max ${Math.max(...held.baseline).toFixed(1)} ms`,
    );
    console.log(
      `[perf] 31 concurrent reveals (HTTP, full request): wall ${rev.ms.toFixed(0)} ms; lock held p50 ${pct(held.reveal, 50).toFixed(1)} ms, p95 ${pct(held.reveal, 95).toFixed(1)} ms, max ${Math.max(...held.reveal).toFixed(1)} ms`,
    );
    expect(held.reveal.length).toBe(31);
    expect(pct(held.reveal, 95)).toBeLessThan(100);
  }, 120_000);
});
