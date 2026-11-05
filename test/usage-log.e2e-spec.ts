/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { redactText } from './../src/audit/audit-payload.js';
import { looksLikeIdDocInText } from './../src/common/id-doc-not-in-url.js';
import { UsageLogBuffer } from './../src/usage/usage-log.buffer.js';
import { applyUsageLog } from './../src/usage/usage-log.middleware.js';
import { UsageLogPurgeService } from './../src/usage/usage-purge.service.js';
import { UsageLogErasure } from './../src/usage/usage-erasure.service.js';
import { USAGE_LOG_WRITER } from './../src/usage/usage-log.types.js';
import type { UsageLogRow } from './../src/usage/usage-log.types.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';
import { registerConsent } from './helpers/legal-consent.js';

/**
 * Story 20.7 (FR-133..135, AD-100): the usage log, against the real database (a throw-away clone, see
 * test/helpers/global-test-db.ts). Every test restores the state it changes: the rows it writes are
 * identified by their `requestId` and deleted; the file runs in any order.
 */
const BASE = '/api/v1';
const TAG = randomUUID().replace(/-/g, '').slice(0, 8);
const CEDULA = '98765432'; // sentinel: it must be found NOWHERE in Usage_Logs
const SENTINELS = [
  CEDULA,
  `TOK${TAG}`,
  `COOK${TAG}`,
  `BEAR${TAG}`,
  `PASS${TAG}`,
  `NEXT${TAG}`,
  `mail${TAG}@sentinel.test`,
];

interface Booted {
  app: NestExpressApplication;
  prisma: PrismaService;
  buffer: UsageLogBuffer;
  server: () => request.Agent;
  close: () => Promise<void>;
}

async function boot(
  env: Record<string, string> = {},
  writer?: { insert: (rows: readonly UsageLogRow[]) => Promise<void> },
): Promise<Booted> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true });
  if (writer) {
    builder = builder.overrideProvider(USAGE_LOG_WRITER).useValue(writer);
  }
  const moduleFixture: TestingModule = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.set('trust proxy', 1);
  applyRequestContext(app);
  const buffer = app.get(UsageLogBuffer);
  applyUsageLog(app, buffer);
  app.use(
    cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createGlobalValidationPipe());
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').setVersion('1').build(),
    ),
  );
  app.enableShutdownHooks();
  await app.init();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    app,
    prisma: app.get(PrismaService),
    buffer,
    server: () => request.agent(base),
    close: () => app.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Usage log (e2e, Story 20.7)', { timeout: 120_000 }, () => {
  let t: Booted;
  let admin: { id: string; token: string };
  const rids: string[] = [];
  const track = (res: request.Response): string => {
    const rid = res.headers['x-request-id'];
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);
    rids.push(rid);
    return rid;
  };
  const rowsOf = (ids: string[]) =>
    t.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "id"::text AS "id", "ts", "method", "route", "status", "durationMs", "actorType", "actorId",
              host("ip") AS "ip", "userAgent", "requestId"
         FROM "Usage_Logs" WHERE "requestId" = ANY($1::uuid[]) ORDER BY "id"`,
      ids,
    );
  const flush = async () => {
    await t.buffer.flush(true, true);
  };
  const adminGet = (path: string) =>
    t
      .server()
      .get(`${BASE}/admin/audit/usage${path}`)
      .set('Authorization', `Bearer ${admin.token}`);

  beforeAll(async () => {
    t = await boot({ USAGE_LOG_FLUSH_MS: '50' });
    const a = await t.prisma.adminUser.create({
      data: {
        username: `e2e-207-${TAG}`,
        email: `e2e-207-${TAG}@212collectorsclub.test`,
        passwordHash: await argon2.hash('x'.repeat(16), {
          type: argon2.argon2id,
        }),
      },
    });
    admin = { id: a.id, token: await mintAdminToken(t.app, a.id) };
  });
  afterAll(async () => {
    await flush().catch(() => undefined);
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Usage_Logs" WHERE "requestId" = ANY($1::uuid[])`,
      rids,
    );
    await t.prisma.adminUser
      .delete({ where: { id: admin.id } })
      .catch(() => undefined);
    await t.close();
  });

  describe('AC2/AC3: what is recorded, and what never is', () => {
    it('a request with a token, a cedula, a query string, cookies and an Authorization header is recorded as its TEMPLATE, and no sentinel is in ANY column of the table', async () => {
      const orderId = randomUUID();
      const res = await t
        .server()
        .get(
          `${BASE}/orders/${orderId}?idDoc=V-${CEDULA}&token=TOK${TAG}&next=NEXT${TAG}&email=mail${TAG}@sentinel.test`,
        )
        .set('Authorization', `Bearer BEAR${TAG}`)
        .set('Cookie', `cc_session=COOK${TAG}; cartId=COOK${TAG}`)
        .set('User-Agent', 'e2e-207 agent');
      const rid = track(res);
      await flush();
      const rows = await rowsOf([rid]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        method: 'GET',
        route: `${BASE}/orders/:orderId`,
        status: res.status,
        actorType: 'ANON',
        actorId: null,
        ip: '127.0.0.1',
        userAgent: 'e2e-207 agent',
        // the X-Request-Id the client saw is the one recorded
        requestId: rid,
      });
      expect(Number(rows[0].durationMs)).toBeGreaterThanOrEqual(0);
      // the whole table, every column of every row, as text
      const all = await t.prisma.$queryRawUnsafe<{ t: string }[]>(
        `SELECT t::text AS t FROM "Usage_Logs" t`,
      );
      const dump = all.map((r) => r.t).join('\n');
      for (const s of SENTINELS) expect(dump, s).not.toContain(s);
      expect(dump).not.toContain(orderId);
      // and no row of the table, whoever wrote it, looks like a cedula / a phone / an e-mail to the guard
      for (const r of all) {
        expect(looksLikeIdDocInText(r.t), r.t).toBe(false);
        expect(
          redactText(r.t).hits.filter((h) => h !== 'CARD'),
          r.t,
        ).toEqual([]);
      }
    });

    it('the IP is the client address of the trusted proxy design (docs 17.8): X-Forwarded-For counted from the right, a forged left part ignored', async () => {
      const res = await t
        .server()
        .get(`${BASE}/categories`)
        .set('X-Forwarded-For', '1.1.1.1, 198.51.100.9');
      const rid = track(res);
      const bad = await t
        .server()
        .get(`${BASE}/categories`)
        .set('X-Forwarded-For', "'; DROP TABLE x; --");
      const ridBad = track(bad);
      await flush();
      expect((await rowsOf([rid]))[0].ip).toBe('198.51.100.9');
      // garbage is never stored as an address: the socket's, or null, never the text
      const ip = (await rowsOf([ridBad]))[0].ip;
      expect([null, '127.0.0.1']).toContain(ip);
    });

    it('a 404 is __unmatched__ and the URL (a token, a cedula) is nowhere', async () => {
      const res = await t
        .server()
        .get(`${BASE}/nope/TOK${TAG}/V-${CEDULA}?x=y`);
      expect(res.status).toBe(404);
      const rid = track(res);
      await flush();
      const rows = await rowsOf([rid]);
      expect(rows[0]).toMatchObject({ route: '__unmatched__', status: 404 });
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(CEDULA);
      expect(dump).not.toContain(`TOK${TAG}`);
    });

    it('the rejection of a guard is recorded too (an interceptor would not see it): admin route without a token', async () => {
      const res = await t.server().get(`${BASE}/admin/audit/head`);
      expect(res.status).toBe(401);
      const rid = track(res);
      await flush();
      expect((await rowsOf([rid]))[0]).toMatchObject({
        route: `${BASE}/admin/audit/head`,
        status: 401,
        actorType: 'ANON',
      });
    });

    it('a failed customer login (the only place it shows, A95) has no email nor password in the row', async () => {
      const res = await t
        .server()
        .post(`${BASE}/auth/login`)
        .send({ email: `mail${TAG}@sentinel.test`, password: `PASS${TAG}` });
      expect(res.status).toBe(401);
      const rid = track(res);
      await flush();
      const rows = await rowsOf([rid]);
      expect(rows[0]).toMatchObject({
        method: 'POST',
        route: `${BASE}/auth/login`,
        status: 401,
      });
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(`PASS${TAG}`);
      expect(dump).not.toContain(`mail${TAG}`);
    });

    it('the Stripe webhook is recorded without its body', async () => {
      const res = await t
        .server()
        .post(`${BASE}/payments/stripe/webhook`)
        .set('Stripe-Signature', 't=1,v1=bad')
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            data: { object: { email: `mail${TAG}@sentinel.test` } },
          }),
        );
      const rid = track(res);
      await flush();
      const rows = await rowsOf([rid]);
      expect(rows[0]).toMatchObject({
        method: 'POST',
        route: `${BASE}/payments/stripe/webhook`,
      });
      expect(JSON.stringify(rows)).not.toContain(`mail${TAG}`);
    });

    it('the actor: a session cookie of a customer is CUSTOMER with its id; an admin token is ADMIN with its id', async () => {
      const email = `e2e-207-${TAG}-a@212collectorsclub.test`;
      await t
        .server()
        .post(`${BASE}/auth/register`)
        .send({
          ...registerConsent(),
          email,
          password: `PASS${TAG}-long-enough`,
          name: 'Cliente Uso',
        })
        .expect(201);
      try {
        const c = await t.prisma.customer.update({
          where: { email },
          data: { emailVerified: true },
        });
        const login = await t
          .server()
          .post(`${BASE}/auth/login`)
          .send({ email, password: `PASS${TAG}-long-enough` })
          .expect(200);
        const cookie = (login.headers['set-cookie'] as unknown as string[])
          .find((x) => x.startsWith('cc_session='))!
          .split(';')[0];
        const me = await t
          .server()
          .get(`${BASE}/auth/me`)
          .set('Cookie', cookie);
        expect(me.status).toBe(200);
        const ridMe = track(me);
        const head = await t
          .server()
          .get(`${BASE}/admin/audit/head`)
          .set('Authorization', `Bearer ${admin.token}`);
        const ridAdmin = track(head);
        track(login);
        await flush();
        const rows = await rowsOf([ridMe, ridAdmin]);
        expect(rows.find((r) => r.requestId === ridMe)).toMatchObject({
          actorType: 'CUSTOMER',
          actorId: c.id,
        });
        expect(rows.find((r) => r.requestId === ridAdmin)).toMatchObject({
          actorType: 'ADMIN',
          actorId: admin.id,
        });
      } finally {
        await t.prisma.$executeRawUnsafe(
          `DELETE FROM "Usage_Logs" WHERE "actorType" = 'CUSTOMER' AND "actorId" IN (SELECT id FROM "Customers" WHERE email = $1)`,
          email,
        );
        await t.prisma.customerVerification.deleteMany({
          where: { identifier: email },
        });
        await t.prisma.customer.deleteMany({ where: { email } });
      }
    });

    it.each([
      ['/api/v1/health'],
      ['/api/docs'],
      ['/api/docs-json'],
      ['/uploads/public/nothing.png'],
    ])('%s is not recorded', async (path) => {
      const res = await t.server().get(path);
      const rid = res.headers['x-request-id'];
      await flush();
      expect(await rowsOf([rid])).toHaveLength(0);
    });

    it('a header larger than the column is cut: the user agent is at most 200 characters', async () => {
      const res = await t
        .server()
        .get(`${BASE}/orders/${randomUUID()}`)
        .set('User-Agent', `ua-${'x'.repeat(600)}`);
      const rid = track(res);
      await flush();
      const ua = (await rowsOf([rid]))[0].userAgent as string;
      expect(ua.length).toBeLessThanOrEqual(200);
    });
  });

  describe('AC4/AC5: never blocks, never loses, never duplicates', () => {
    it('200 requests in Promise.all are all recorded, once each', async () => {
      const results = await Promise.all(
        Array.from({ length: 200 }, () => t.server().get(`${BASE}/categories`)),
      );
      const ids = results.map(track);
      expect(new Set(ids).size).toBe(200);
      await flush();
      const rows = await rowsOf(ids);
      expect(rows).toHaveLength(200);
      expect(new Set(rows.map((r) => r.requestId)).size).toBe(200);
      expect(rows.every((r) => r.route === `${BASE}/categories`)).toBe(true);
      expect(t.buffer.stats().droppedSinceBoot).toBe(0);
    });

    it('the timer alone writes them (no explicit flush)', async () => {
      const res = await t.server().get(`${BASE}/categories`);
      const rid = track(res);
      let rows: Record<string, unknown>[] = [];
      for (let i = 0; i < 40 && rows.length === 0; i++) {
        await sleep(50);
        rows = await rowsOf([rid]);
      }
      expect(rows).toHaveLength(1);
    });

    it('closing the app (a normal shutdown) writes what is pending: nothing is lost', async () => {
      const b = await boot({ USAGE_LOG_FLUSH_MS: '60000' }); // the timer will not fire: only the shutdown can write
      const mine: string[] = [];
      try {
        for (let i = 0; i < 25; i++) {
          const r = await b.server().get(`${BASE}/categories`);
          mine.push(r.headers['x-request-id']);
        }
        expect(b.buffer.stats().buffered).toBe(25);
        const seen = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "Usage_Logs" WHERE "requestId" = ANY($1::uuid[])`,
          mine,
        );
        expect(seen[0].n).toBe(0);
      } finally {
        await b.close();
      }
      const after = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "Usage_Logs" WHERE "requestId" = ANY($1::uuid[])`,
        mine,
      );
      expect(after[0].n).toBe(25);
      rids.push(...mine);
    });

    it('chaos: with the database of the log down every request answers the same (200) and droppedSinceBoot grows; memory stays at the cap', async () => {
      let attempts = 0;
      const b = await boot(
        {
          USAGE_LOG_BUFFER_MAX: '100',
          USAGE_LOG_FLUSH_BATCH: '20',
          USAGE_LOG_FLUSH_MS: '50',
        },
        {
          insert: () => {
            attempts += 1;
            return Promise.reject(new Error('connection refused'));
          },
        },
      );
      try {
        const results = await Promise.all(
          Array.from({ length: 300 }, () =>
            b.server().get(`${BASE}/categories`),
          ),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        const s = b.buffer.stats();
        expect(s.buffered).toBeLessThanOrEqual(100);
        expect(s.droppedSinceBoot).toBeGreaterThanOrEqual(150);
        expect(s.lastFlushError).toBe('connection refused');
        expect(attempts).toBeGreaterThan(0);
        // and the admin view says so
        const stats = await b
          .server()
          .get(`${BASE}/admin/audit/usage/stats`)
          .set(
            'Authorization',
            `Bearer ${await mintAdminToken(b.app, admin.id)}`,
          );
        expect(stats.status).toBe(200);
        expect(stats.body.droppedSinceBoot).toBeGreaterThanOrEqual(150);
        expect(stats.body.lastFlushError).toBe('connection refused');
      } finally {
        await b.close();
      }
    });

    it('chaos: a database that hangs for ever does not hold a request or the shutdown', async () => {
      const b = await boot(
        { USAGE_LOG_FLUSH_MS: '50', USAGE_LOG_FLUSH_BATCH: '5' },
        { insert: () => new Promise<void>(() => undefined) },
      );
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: 40 }, () => b.server().get(`${BASE}/categories`)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      await b.close();
      // the shutdown flush gives up after 2 s (plus the rest of the close)
      expect(Date.now() - t0).toBeLessThan(10_000);
    });

    it('the middleware adds well under 2 ms p95 to a request (microbenchmark of its own work: build the row and queue it)', async () => {
      const { createUsageLogMiddleware } =
        await import('./../src/usage/usage-log.middleware.js');
      const { EventEmitter } = await import('node:events');
      const sink = { push: () => undefined } as unknown as UsageLogBuffer;
      const mw = createUsageLogMiddleware(sink);
      const samples: number[] = [];
      for (let i = 0; i < 20_000; i++) {
        const req = {
          method: 'GET',
          originalUrl: `/api/v1/orders/${randomUUID()}?token=abc`,
          route: { path: '/api/v1/orders/:orderId' },
          ip: '203.0.113.7',
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
          },
        };
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200,
          getHeader: () => randomUUID(),
        });
        const t0 = process.hrtime.bigint();
        mw(req as never, res as never, () => undefined);
        res.emit('finish');
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95)];
      process.stdout.write(
        `[20.7 middleware microbench] p50=${samples[10_000].toFixed(4)} ms p95=${p95.toFixed(4)} ms p99=${samples[19_800].toFixed(4)} ms\n`,
      );
      // threshold documented in docs/deployment.md 19: 20 x the usual figure, so a slow CI box does not flake
      expect(p95).toBeLessThan(2);
    });
  });

  describe('AC6: the admin view', () => {
    const seed: string[] = [];
    beforeAll(async () => {
      // 130 rows with known shapes, written straight into the table (identified by requestId)
      for (let i = 0; i < 130; i++) {
        const rid = randomUUID();
        seed.push(rid);
        await t.prisma.$executeRawUnsafe(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","actorId","ip","userAgent","requestId")
           VALUES ($1::timestamptz, $2, $3, $4::smallint, $5, $6, $7::uuid, $8::inet, $9, $10::uuid)`,
          new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + i * 1000).toISOString(),
          i % 2 ? 'POST' : 'GET',
          i < 60 ? '/zz207/alpha/:id' : '/zz207/beta/:id',
          i % 10 === 0 ? 500 : i % 3 === 0 ? 404 : 200,
          i,
          i % 4 === 0 ? 'CUSTOMER' : 'ANON',
          i % 4 === 0 ? admin.id : null,
          `198.51.100.${i % 5}`,
          'seed-207',
          rid,
        );
      }
      rids.push(...seed);
    });

    const page = async (q: string) => {
      const r = await adminGet(q);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as {
        items: Record<string, unknown>[];
        nextCursor: string | null;
      };
    };

    it('401 without a token, and with a customer cookie', async () => {
      await t.server().get(`${BASE}/admin/audit/usage`).expect(401);
      await t.server().get(`${BASE}/admin/audit/usage/stats`).expect(401);
      await t
        .server()
        .get(`${BASE}/admin/audit/usage`)
        .set('Cookie', 'cc_session=nope')
        .expect(401);
    });

    it('paginates by cursor, 50 per page, newest first, without repeating or skipping a row', async () => {
      const all: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const p: {
          items: Record<string, unknown>[];
          nextCursor: string | null;
        } = await page(`?route=/zz207/${cursor ? `&cursor=${cursor}` : ''}`);
        expect(p.items.length).toBeLessThanOrEqual(50);
        all.push(...p.items.map((i) => i.id as string));
        cursor = p.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(all).toHaveLength(130);
      expect(new Set(all).size).toBe(130);
      const nums = all.map((i) => BigInt(i));
      expect(nums.every((n, i) => i === 0 || n < nums[i - 1])).toBe(true);
    });

    it('filters: route prefix, status, statusClass, actorType, actorId, ip (and CIDR), requestId, from/to', async () => {
      const alpha = await page('?route=/zz207/alpha');
      expect(
        alpha.items.every((i) =>
          (i.route as string).startsWith('/zz207/alpha'),
        ),
      ).toBe(true);
      expect(alpha.items).toHaveLength(50);
      expect(
        (await page('?route=/zz207/&status=404&limit=1')).items.every(
          (i) => i.status === 404,
        ),
      ).toBe(true);
      const five = await page('?route=/zz207/&statusClass=5xx');
      expect(five.items).toHaveLength(13);
      expect(five.items.every((i) => (i.status as number) >= 500)).toBe(true);
      const cust = await page(
        `?route=/zz207/&actorType=CUSTOMER&actorId=${admin.id}`,
      );
      expect(cust.items).toHaveLength(33);
      const ip = await page('?route=/zz207/&ip=198.51.100.3');
      expect(ip.items.length).toBeGreaterThan(0);
      expect(ip.items.every((i) => i.ip === '198.51.100.3')).toBe(true);
      const cidr = await page('?route=/zz207/&ip=198.51.100.0/24');
      expect(cidr.items).toHaveLength(50);
      const one = await page(`?requestId=${seed[7]}`);
      expect(one.items).toHaveLength(1);
      expect(one.items[0]).toMatchObject({
        requestId: seed[7],
        userAgent: 'seed-207',
        method: 'POST',
      });
      const day = await page('?route=/zz207/&from=2026-11-01&to=2026-11-01');
      expect(day.items).toHaveLength(50);
      const none = await page('?route=/zz207/&from=2026-11-02');
      expect(none.items).toHaveLength(0);
      const exact = await page(
        '?route=/zz207/&from=2026-11-01T10:00:10Z&to=2026-11-01T10:00:12Z',
      );
      expect(exact.items).toHaveLength(3);
      // a LIKE wildcard in the prefix is a literal
      expect((await page('?route=/zz207%25')).items).toHaveLength(0);
    });

    it.each([
      ['?from=hoy'],
      ['?from=2026-11-05&to=2026-11-01'],
      ['?status=abc'],
      ['?status=700'],
      ['?statusClass=9xx'],
      ['?status=200&statusClass=2xx'],
      ['?actorType=root'],
      ['?actorId=zz'],
      ['?requestId=zz'],
      ['?ip=999.9.9.9'],
      ['?cursor=-1'],
      ['?cursor=abc'],
      ['?route=nosl'],
      ['?status=200&status=404'],
    ])('%s -> 400 USAGE_FILTER_INVALID', async (q) => {
      const r = await adminGet(q);
      expect(r.status).toBe(400);
      expect(r.body.errorCode).toBe('USAGE_FILTER_INVALID');
    });

    it('a cedula in the URL is refused and never echoed or recorded', async () => {
      const r = await adminGet(`?route=/zz207&idDoc=V-${CEDULA}`);
      expect(r.status).toBe(400);
      expect(r.body.errorCode).toBe('ID_DOC_IN_URL_NOT_ALLOWED');
      expect(JSON.stringify(r.body)).not.toContain(CEDULA);
      const r2 = await adminGet(`?route=/orders/V${CEDULA}`);
      expect(r2.status).toBe(400);
    });

    it('the query itself is NOT recorded (the view would feed itself), and /stats neither', async () => {
      const r = await adminGet('?route=/zz207/');
      const s = await t
        .server()
        .get(`${BASE}/admin/audit/usage/stats`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(s.status).toBe(200);
      const ids = [r.headers['x-request-id'], s.headers['x-request-id']];
      await flush();
      expect(await rowsOf(ids)).toHaveLength(0);
      const fromRoute = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "Usage_Logs" WHERE "route" LIKE '/api/v1/admin/audit/usage%'`,
      );
      expect(fromRoute[0].n).toBe(0);
    });

    it('/stats is {buffered, droppedSinceBoot (+ droppedLowPrioritySinceBoot, lastDropAt), lastFlushAt, lastFlushError, writtenSinceBoot}', async () => {
      const s = await t
        .server()
        .get(`${BASE}/admin/audit/usage/stats`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(Object.keys(s.body as object).sort()).toEqual(
        [
          'buffered',
          'droppedLowPrioritySinceBoot',
          'droppedSinceBoot',
          'lastDropAt',
          'lastFlushAt',
          'lastFlushError',
          'writtenSinceBoot',
        ].sort(),
      );
      expect(s.body.lastFlushError).toBeNull();
      expect(typeof s.body.lastFlushAt).toBe('string');
    });

    it('read-only: there is no route that writes, exports or deletes', async () => {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        const r = await t
          .server()
          [m](`${BASE}/admin/audit/usage`)
          .set('Authorization', `Bearer ${admin.token}`);
        expect(r.status).toBe(404);
      }
      await t
        .server()
        .get(`${BASE}/admin/audit/usage/export`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(404);
    });

    it('Swagger documents both routes, the filters and the errorCodes', () => {
      // the app of this file only mounts a minimal document: build the real one from the controllers
      const doc = SwaggerModule.createDocument(
        t.app,
        new DocumentBuilder().setTitle('t').setVersion('1').build(),
      ) as unknown as {
        paths: Record<
          string,
          Record<
            string,
            {
              parameters?: { name: string }[];
              responses: Record<string, { description?: string }>;
            }
          >
        >;
      };
      const list = doc.paths[`${BASE}/admin/audit/usage`].get;
      expect(list.parameters!.map((p) => p.name).sort()).toEqual(
        [
          'actorId',
          'actorType',
          'cursor',
          'from',
          'ip',
          'requestId',
          'route',
          'status',
          'statusClass',
          'to',
        ].sort(),
      );
      expect(Object.keys(list.responses)).toEqual(
        expect.arrayContaining(['200', '400', '401', '503']),
      );
      expect(list.responses['400'].description).toContain(
        'USAGE_FILTER_INVALID',
      );
      expect(list.responses['400'].description).toContain(
        'ID_DOC_IN_URL_NOT_ALLOWED',
      );
      expect(list.responses['401'].description).toBe('INVALID_ADMIN_TOKEN');
      expect(list.responses['503'].description).toBe(
        'USAGE_QUERY_TIMEOUT | AUDIT_UNAVAILABLE',
      );
      const stats = doc.paths[`${BASE}/admin/audit/usage/stats`].get;
      expect(Object.keys(stats.responses)).toEqual(
        expect.arrayContaining(['200', '401']),
      );
    });
  });

  describe('retention: the 7-day purge (Story 20.8 will call the same method)', () => {
    const MARK = '/zz207/purge';
    const insert = (ageDays: number, n: number) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
         SELECT now() - make_interval(days => $1::int) - (g || ' seconds')::interval, 'GET', $2, 200, 1, 'ANON', gen_random_uuid()
           FROM generate_series(1, $3::int) g`,
        ageDays,
        MARK,
        n,
      );
    const count = async (where = '') =>
      Number(
        (
          await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM "Usage_Logs" WHERE "route" = $1 ${where}`,
            MARK,
          )
        )[0].n,
      );
    afterEach(async () => {
      await t.prisma.$executeRawUnsafe(
        `DELETE FROM "Usage_Logs" WHERE "route" = $1`,
        MARK,
      );
    });

    it('deletes what is older than the limit, in batches, keeps the rest, and a second run does nothing', async () => {
      await insert(8, 2_350);
      await insert(10, 100);
      await insert(6, 300);
      await insert(0, 50);
      const purge = t.app.get(UsageLogPurgeService);
      const audit = Number(
        (
          await t.prisma.$queryRaw<
            { n: bigint }[]
          >`SELECT count(*)::bigint AS n FROM "Audit_Events"`
        )[0].n,
      );
      const r = await purge.purgeExpired({ days: 7, batch: 1_000, pauseMs: 1 });
      // the purge is global: other rows older than 7 days (a dev database) go too; ours are all there
      expect(r.rows).toBeGreaterThanOrEqual(2_450);
      expect(r.batches).toBeGreaterThanOrEqual(3);
      expect(r.truncated).toBe(false);
      expect(await count()).toBe(350);
      expect(await count(`AND "ts" < now() - interval '7 days'`)).toBe(0);
      const again = await purge.purgeExpired({ days: 7, pauseMs: 1 });
      expect(again.rows).toBe(0);
      expect(await count()).toBe(350);
      // never the immutable log
      expect(
        Number(
          (
            await t.prisma.$queryRaw<
              { n: bigint }[]
            >`SELECT count(*)::bigint AS n FROM "Audit_Events"`
          )[0].n,
        ),
      ).toBe(audit);
    });

    it('two purges at once: one does the work, the other returns without error (advisory lock / single flight)', async () => {
      await insert(9, 3_000);
      const purge = t.app.get(UsageLogPurgeService);
      const [a, b] = await Promise.all([
        purge.purgeExpired({ days: 7, batch: 500, pauseMs: 1 }),
        purge.purgeExpired({ days: 7, batch: 500, pauseMs: 1 }),
      ]);
      expect(a.rows + b.rows).toBeGreaterThanOrEqual(3_000);
      expect(await count()).toBe(0);
    });

    it('the run is capped in time: a long one is truncated and the rest goes in the next run', async () => {
      await insert(9, 3_000);
      const purge = t.app.get(UsageLogPurgeService);
      const r = await purge.purgeExpired({
        days: 7,
        batch: 100,
        pauseMs: 20,
        maxRunMs: 60,
      });
      expect(r.truncated).toBe(true);
      expect(await count()).toBeGreaterThan(0);
      await purge.purgeExpired({ days: 7, pauseMs: 1 });
      expect(await count()).toBe(0);
    });

    it('PURGE_USAGE_LOG_DAYS is honoured (1..30)', async () => {
      await insert(3, 10);
      await insert(0, 5);
      const purge = t.app.get(UsageLogPurgeService);
      await purge.purgeExpired({ days: 2, pauseMs: 1 });
      expect(await count()).toBe(5);
    });
  });

  describe('Story 20.6 x 20.7: the anonymization removes the usage rows, even those still in memory', () => {
    const mkCustomer = async (key: string) => {
      const email = `e2e-207-${TAG}-${key}@212collectorsclub.test`;
      await t
        .server()
        .post(`${BASE}/auth/register`)
        .send({
          ...registerConsent(),
          email,
          password: `PASS${TAG}-long-enough`,
          name: 'Cliente Uso',
        })
        .expect(201);
      const c = await t.prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      return c;
    };
    const cleanup = async (ids: string[]) => {
      await t.prisma.$executeRawUnsafe(
        `DELETE FROM "Usage_Logs" WHERE "actorId" = ANY($1::uuid[])`,
        ids,
      );
      await t.prisma.customerVerification.deleteMany({
        where: { value: { in: ids } },
      });
      await t.prisma.customer.deleteMany({ where: { id: { in: ids } } });
    };
    const row = (id: string, over: Partial<UsageLogRow> = {}): UsageLogRow => ({
      ts: Date.now(),
      method: 'GET',
      route: '/zz207/anon',
      status: 200,
      durationMs: 1,
      actorType: 'CUSTOMER',
      actorId: id,
      ip: '203.0.113.50',
      userAgent: 'anon-207',
      requestId: randomUUID(),
      ...over,
    });
    const usageOf = async (id: string) =>
      Number(
        (
          await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM "Usage_Logs" WHERE "actorId" = $1::uuid`,
            id,
          )
        )[0].n,
      );
    const anonymize = (id: string, email: string) =>
      t
        .server()
        .post(`${BASE}/admin/customers/${id}/anonymize`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          confirmEmail: email,
          reason: `Solicitud del titular por WhatsApp, ref ${TAG}, 2026-11-04`,
        });

    it('rows in the table AND rows still in the buffer AND a row that arrives after the commit: none survives', async () => {
      const c = await mkCustomer('er1');
      const other = await mkCustomer('er2');
      try {
        // already written
        await t.prisma.$executeRawUnsafe(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","actorId","ip","requestId")
           VALUES (now(),'GET','/zz207/anon',200,1,'CUSTOMER',$1::uuid,'203.0.113.50'::inet, gen_random_uuid()),
                  (now(),'GET','/zz207/anon',200,1,'CUSTOMER',$2::uuid,'203.0.113.51'::inet, gen_random_uuid())`,
          c.id,
          other.id,
        );
        // pending in memory (the timer is 50 ms: stop it from writing between the push and the anonymization)
        const b = t.buffer as unknown as {
          flush: (e?: boolean, f?: boolean) => Promise<void>;
        };
        const realFlush = b.flush.bind(t.buffer);
        b.flush = () => Promise.resolve();
        try {
          t.buffer.push(row(c.id));
          t.buffer.push(row(c.id));
          t.buffer.push(row(other.id));
          const preview = await t
            .server()
            .get(`${BASE}/admin/customers/${c.id}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          expect(preview.body.anonymization.willDelete.usageLogs).toBe(1);
          const res = await anonymize(c.id, c.email);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          // a request of the (former) session finishing AFTER the commit
          t.buffer.push(row(c.id));
        } finally {
          b.flush = realFlush;
        }
        await flush();
        expect(await usageOf(c.id)).toBe(0);
        // the other customer's rows are untouched: the one in the table and the one that was in memory
        expect(await usageOf(other.id)).toBe(2);
      } finally {
        await cleanup([c.id, other.id]);
      }
    });

    it('a write IN FLIGHT when the account is anonymized cannot bring the rows back (the INSERT itself refuses an anonymized customer)', async () => {
      const c = await mkCustomer('er3');
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const real = t.app.get<{
          insert: (r: readonly UsageLogRow[]) => Promise<void>;
        }>(USAGE_LOG_WRITER);
        const orig = real.insert.bind(real);
        let started = false;
        real.insert = async (rows) => {
          started = true;
          await gate; // the batch was TAKEN from the buffer before the commit, and is written after it
          return orig(rows);
        };
        try {
          t.buffer.push(row(c.id));
          t.buffer.push(row(c.id));
          const flushing = t.buffer.flush(true, true);
          for (let i = 0; i < 100 && !started; i++) await sleep(10);
          expect(started).toBe(true);
          const done = anonymize(c.id, c.email).then((r) => r);
          await sleep(300);
          release();
          expect((await done).status).toBe(200);
          await flushing;
        } finally {
          real.insert = orig;
        }
        expect(await usageOf(c.id)).toBe(0);
      } finally {
        await cleanup([c.id]);
      }
    });

    it('the INSERT refuses a row of an anonymized customer, and keeps the others of the same batch', async () => {
      const c = await mkCustomer('er4');
      const live = await mkCustomer('er5');
      try {
        expect((await anonymize(c.id, c.email)).status).toBe(200);
        const real = t.app.get<{
          insert: (r: readonly UsageLogRow[]) => Promise<void>;
        }>(USAGE_LOG_WRITER);
        const keep = row(live.id);
        await real.insert([
          row(c.id),
          keep,
          row(c.id, { actorType: 'ANON', actorId: null }),
        ]);
        expect(await usageOf(c.id)).toBe(0);
        expect(await usageOf(live.id)).toBe(1);
        const anon = await rowsOf([keep.requestId]);
        expect(anon).toHaveLength(1);
        await t.prisma.$executeRawUnsafe(
          `DELETE FROM "Usage_Logs" WHERE "route" = '/zz207/anon'`,
        );
      } finally {
        await cleanup([c.id, live.id]);
      }
    });

    it('UsageLogErasure.afterCommit never throws (a failing sweep is logged)', async () => {
      const e = t.app.get(UsageLogErasure);
      const prisma = t.app.get(PrismaService);
      const spy = vi
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('db down'));
      await expect(e.afterCommit(randomUUID())).resolves.toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('the limited role and the shape of the table', () => {
    it('INSERT, SELECT and DELETE work; UPDATE and TRUNCATE are not granted to a limited role', async () => {
      const u = new URL(adminDatabaseUrl());
      u.searchParams.delete('schema');
      const owner = new pg.Client({ connectionString: u.toString() });
      await owner.connect();
      try {
        const roles = await owner.query<{ rolname: string }>(
          `SELECT rolname FROM pg_roles WHERE rolname ~ '^collectorsclub_[a-z0-9_]{1,30}_app$'`,
        );
        for (const { rolname } of roles.rows) {
          const p = await owner.query<{
            u: boolean;
            t: boolean;
            i: boolean;
            d: boolean;
            s: boolean;
          }>(
            `SELECT has_table_privilege($1, 'public."Usage_Logs"', 'UPDATE') AS u,
                    has_table_privilege($1, 'public."Usage_Logs"', 'TRUNCATE') AS t,
                    has_table_privilege($1, 'public."Usage_Logs"', 'INSERT') AS i,
                    has_table_privilege($1, 'public."Usage_Logs"', 'DELETE') AS d,
                    has_table_privilege($1, 'public."Usage_Logs"', 'SELECT') AS s`,
            [rolname],
          );
          expect(p.rows[0], rolname).toEqual({
            u: false,
            t: false,
            i: true,
            d: true,
            s: true,
          });
        }
        // the shape the story asks for
        const idx = await owner.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE tablename = 'Usage_Logs' ORDER BY indexname`,
        );
        const defs = idx.rows.map((r) => r.indexdef).join('\n');
        // pg_indexes prints the column names unquoted when they need no quotes
        for (const s of [
          'USING btree (ts)',
          '("actorId", ts)',
          '(route varchar_pattern_ops, ts)',
          '(status, ts)',
          '(ip, ts)',
          '("requestId")',
        ]) {
          expect(defs).toContain(s);
        }
        const cols = await owner.query<{
          column_name: string;
          data_type: string;
        }>(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'Usage_Logs'`,
        );
        const byName = Object.fromEntries(
          cols.rows.map((c) => [c.column_name, c.data_type]),
        );
        expect(byName).toMatchObject({
          id: 'bigint',
          ts: 'timestamp with time zone',
          route: 'character varying',
          status: 'smallint',
          durationMs: 'integer',
          actorId: 'uuid',
          ip: 'inet',
          userAgent: 'character varying',
          requestId: 'uuid',
        });
        const rr = await owner.query(
          `SELECT count(*)::int AS n FROM "Retention_Runs"`,
        );
        expect(rr.rows[0].n).toBeGreaterThanOrEqual(0);
      } finally {
        await owner.end();
      }
    });
  });
});
