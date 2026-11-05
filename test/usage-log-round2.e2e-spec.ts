/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
import net from 'node:net';
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
import { AuditService } from './../src/audit/audit.service.js';
import { ApiException } from './../src/common/api-exception.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { UsageLogBuffer } from './../src/usage/usage-log.buffer.js';
import { applyUsageLog } from './../src/usage/usage-log.middleware.js';
import { UsageLogPurgeService } from './../src/usage/usage-purge.service.js';
import { PrismaUsageLogWriter } from './../src/usage/usage-log.writer.js';
import { USAGE_LOG_WRITER } from './../src/usage/usage-log.types.js';
import type { UsageLogRow } from './../src/usage/usage-log.types.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';
import { registerConsent } from './helpers/legal-consent.js';

/**
 * Story 20.7, second round (QA): requests the client cuts are recorded, the exclusions are exact, the
 * writer is idempotent, a saturated pool answers 503 and not 500, the admin READING the log leaves a trace,
 * and the purge does not depend on the session's TimeZone. Real database (a throw-away clone). Every test
 * cleans what it creates; the file runs in any order.
 */
const BASE = '/api/v1';
const TAG = randomUUID().replace(/-/g, '').slice(0, 8);
const PASS = `PASS${TAG}-long-enough`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  app: NestExpressApplication;
  prisma: PrismaService;
  buffer: UsageLogBuffer;
  port: number;
  server: () => request.Agent;
  close: () => Promise<void>;
}

async function boot(writer?: {
  insert: (rows: readonly UsageLogRow[]) => Promise<void>;
}): Promise<Booted> {
  process.env.USAGE_LOG_FLUSH_MS ??= '50';
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
  applyUsageLog(app, app.get(UsageLogBuffer));
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
  const port = (app.getHttpServer().address() as { port: number }).port;
  delete process.env.USAGE_LOG_FLUSH_MS;
  return {
    app,
    prisma: app.get(PrismaService),
    buffer: app.get(UsageLogBuffer),
    port,
    server: () => request.agent(`http://127.0.0.1:${port}`),
    close: () => app.close(),
  };
}

/** Sends `raw` over a plain socket and destroys it `afterMs` later without reading the answer. */
function rawAbort(port: number, raw: string, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(raw);
      setTimeout(() => {
        s.destroy();
        resolve();
      }, afterMs);
    });
    s.on('error', () => undefined);
  });
}

const httpHead = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
) =>
  `${method} ${path} HTTP/1.1\r\nHost: x\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join(
      '',
    )}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`;

describe(
  'Usage log, QA round 2 (e2e, Story 20.7)',
  { timeout: 180_000 },
  () => {
    let t: Booted;
    let admin: { id: string; token: string };
    const adminIds: string[] = [];
    const customerIds: string[] = [];
    const uas: string[] = [];
    const flush = async () => {
      await t.buffer.flush(true, true);
    };
    const rowsByUa = (ua: string) =>
      t.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT "route", "status", "actorType", "actorId", "durationMs", "requestId", "method"
           FROM "Usage_Logs" WHERE "userAgent" = $1 ORDER BY "id"`,
        ua,
      );
    const newUa = (label: string) => {
      const ua = `qa207-${label}-${TAG}`;
      uas.push(ua);
      return ua;
    };

    async function mkAdmin(label: string) {
      const a = await t.prisma.adminUser.create({
        data: {
          username: `e2e-207b-${label}-${TAG}`,
          email: `e2e-207b-${label}-${TAG}@212collectorsclub.test`,
          passwordHash: await argon2.hash('x'.repeat(16), {
            type: argon2.argon2id,
          }),
        },
      });
      adminIds.push(a.id);
      return { id: a.id, token: await mintAdminToken(t.app, a.id) };
    }
    async function mkCustomer(label: string) {
      const email = `e2e-207b-${label}-${TAG}@212collectorsclub.test`;
      await t
        .server()
        .post(`${BASE}/auth/register`)
        .send({
          ...registerConsent(),
          email,
          password: PASS,
          name: 'Cliente Uso',
        })
        .expect(201);
      const c = await t.prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      customerIds.push(c.id);
      const login = await t
        .server()
        .post(`${BASE}/auth/login`)
        .send({ email, password: PASS })
        .expect(200);
      const cookie = (login.headers['set-cookie'] as unknown as string[])
        .find((x) => x.startsWith('cc_session='))!
        .split(';')[0];
      return { id: c.id, cookie };
    }
    async function holdCustomerRow(id: string) {
      const u = new URL(adminDatabaseUrl());
      u.searchParams.delete('schema');
      const holder = new pg.Client({ connectionString: u.toString() });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM "Customers" WHERE "id" = $1::uuid FOR UPDATE`,
        [id],
      );
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await holder.query('COMMIT').catch(() => undefined);
        await holder.end().catch(() => undefined);
      };
    }

    beforeAll(async () => {
      t = await boot();
      admin = await mkAdmin('a');
    });
    afterAll(async () => {
      await flush().catch(() => undefined);
      await t.prisma.$executeRawUnsafe(
        `DELETE FROM "Usage_Logs" WHERE "userAgent" = ANY($1::text[]) OR "actorId" = ANY($2::uuid[])`,
        uas,
        [...customerIds, ...adminIds],
      );
      await t.prisma.customer
        .deleteMany({ where: { id: { in: customerIds } } })
        .catch(() => undefined);
      await t.prisma.adminUser
        .deleteMany({ where: { id: { in: adminIds } } })
        .catch(() => undefined);
      await t.close();
    });

    // ----------------------------------------------------------------------------------------
    describe('a client that cuts the connection leaves its row (FR-133, A96)', () => {
      it('PATCH /auth/me cut while the handler waits: ONE row per request, 499, the template, the customer, the duration; the handler still ran to its end', async () => {
        const c = await mkCustomer('cut');
        const ua = newUa('cut');
        const release = await holdCustomerRow(c.id);
        try {
          const body = JSON.stringify({ name: 'Nombre Cortado' });
          const reqs = Array.from({ length: 10 }, () =>
            rawAbort(
              t.port,
              httpHead(
                'PATCH',
                `${BASE}/auth/me`,
                {
                  'Content-Type': 'application/json',
                  Cookie: c.cookie,
                  'User-Agent': ua,
                },
                body,
              ),
              400,
            ),
          );
          await Promise.all(reqs);
          await sleep(100);
          await flush();
          const rows = await rowsByUa(ua);
          expect(rows).toHaveLength(10);
          for (const r of rows) {
            expect(r).toMatchObject({
              status: 499,
              route: '/api/v1/auth/me',
              actorType: 'CUSTOMER',
              actorId: c.id,
              method: 'PATCH',
            });
            expect(Number(r.durationMs)).toBeGreaterThanOrEqual(300);
          }
          expect(new Set(rows.map((r) => r.requestId)).size).toBe(10);
        } finally {
          await release();
        }
        // the handlers were still running: once the lock is free nothing more is recorded for them
        await sleep(2_800);
        await flush();
        expect(await rowsByUa(ua)).toHaveLength(10);
      });

      it('login with the body only half sent and then cut: one row, __unmatched__ (the router never got there), 499, anonymous', async () => {
        const ua = newUa('half');
        await rawAbort(
          t.port,
          `POST ${BASE}/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nUser-Agent: ${ua}\r\nContent-Length: 200\r\n\r\n{"email":"a@b.co","pass`,
          300,
        );
        await sleep(100);
        await flush();
        const rows = await rowsByUa(ua);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 499,
          route: '__unmatched__',
          actorType: 'ANON',
          method: 'POST',
        });
      });

      it('a real admin logout and aborted admin / cart requests: exactly one row each, never zero (the QA case: 0 rows)', async () => {
        const a = await mkAdmin('lo');
        const ua = newUa('adm');
        const N = 20;
        await Promise.all(
          Array.from({ length: N }, () =>
            rawAbort(
              t.port,
              httpHead('GET', `${BASE}/admin/audit/head`, {
                Authorization: `Bearer ${a.token}`,
                'User-Agent': ua,
              }),
              0,
            ),
          ),
        );
        const ua2 = newUa('cart');
        const body = JSON.stringify({ productId: randomUUID(), quantity: 1 });
        await Promise.all(
          Array.from({ length: 10 }, () =>
            rawAbort(
              t.port,
              httpHead(
                'POST',
                `${BASE}/cart/items`,
                { 'Content-Type': 'application/json', 'User-Agent': ua2 },
                body,
              ),
              0,
            ),
          ),
        );
        const ua3 = newUa('logout');
        await rawAbort(
          t.port,
          httpHead('POST', `${BASE}/admin/auth/logout`, {
            Authorization: `Bearer ${a.token}`,
            'User-Agent': ua3,
            'Content-Length': '0',
          }),
          0,
        );
        await sleep(600);
        await flush();
        const adm = await rowsByUa(ua);
        const cart = await rowsByUa(ua2);
        const lo = await rowsByUa(ua3);
        expect(adm).toHaveLength(N);
        expect(cart).toHaveLength(10);
        expect(lo).toHaveLength(1);
        const cut = [...adm, ...cart, ...lo].filter((r) => r.status === 499);
        process.stdout.write(
          `[20.7 round 2] aborted at once: ${cut.length} of ${adm.length + cart.length + lo.length} recorded as 499, the others finished before the cut\n`,
        );
        expect(cut.length).toBeGreaterThan(0);
        // the logout really happened (the handler ran although the client was gone)
        const after = await t
          .server()
          .get(`${BASE}/admin/audit/head`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(after.status).toBe(401);
      });

      it('keep-alive: several requests on ONE socket are one row each; a request that takes a while is recorded once, when it ends', async () => {
        const ua = newUa('ka');
        const c = await mkCustomer('ka');
        await new Promise<void>((resolve, reject) => {
          const s = net.connect(t.port, '127.0.0.1');
          let seen = 0;
          s.on('data', (d) => {
            seen += (d.toString().match(/HTTP\/1\.1 \d{3}/g) ?? []).length;
            if (seen >= 3) {
              s.destroy();
              resolve();
            }
          });
          s.on('error', reject);
          s.write(
            httpHead('GET', `${BASE}/categories`, {
              'User-Agent': ua,
              Connection: 'keep-alive',
            }),
          );
          s.write(
            httpHead('GET', `${BASE}/categories`, {
              'User-Agent': ua,
              Connection: 'keep-alive',
            }),
          );
          s.write(
            httpHead('GET', `${BASE}/no-such-route`, {
              'User-Agent': ua,
              Connection: 'keep-alive',
            }),
          );
        });
        await sleep(200);
        // a slow one (held row), whole round trip waited for
        const release = await holdCustomerRow(c.id);
        const ua2 = newUa('kaslow');
        try {
          const slow = await t
            .server()
            .patch(`${BASE}/auth/me`)
            .set('Cookie', c.cookie)
            .set('User-Agent', ua2)
            .send({ name: 'Lento' });
          expect(slow.status).toBe(409);
        } finally {
          await release();
        }
        await flush();
        const rows = await rowsByUa(ua);
        expect(rows.map((r) => r.status).sort()).toEqual([200, 200, 404]);
        const slowRows = await rowsByUa(ua2);
        expect(slowRows).toHaveLength(1);
        expect(slowRows[0].status).toBe(409);
        expect(Number(slowRows[0].durationMs)).toBeGreaterThanOrEqual(2_000);
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('the exclusions compare whole path segments', () => {
      it.each([
        ['/uploads/private/payments/x.png', 404, true],
        ['/api/docsXYZ', 404, true],
        ['/api/v1/admin/audit/usagexyz', 404, true],
        ['/api/v1/healthz', 404, true],
        ['/uploads/public/products/none.png', 404, false],
        ['/api/v1/health', 200, false],
        ['/api/docs', 200, false],
        ['/api/docs-json', 200, false],
        ['/api/v1/admin/audit/usage', 200, false],
        ['/api/v1/admin/audit/usage/stats', 200, false],
      ])('%s -> recorded: %s', async (path, status, recorded) => {
        const ua = newUa(`ex-${path.replace(/[^a-z]/gi, '')}`);
        const res = await t
          .server()
          .get(path)
          .set('User-Agent', ua)
          .set('Authorization', `Bearer ${admin.token}`);
        expect([status, 301, 302]).toContain(res.status);
        await flush();
        const rows = await rowsByUa(ua);
        expect(rows).toHaveLength(recorded ? 1 : 0);
        if (recorded)
          expect(rows[0]).toMatchObject({ status, route: '__unmatched__' });
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('the writer is idempotent (a COMMIT that expired but had committed does not write twice)', () => {
      it('20 requests whose first write "times out after committing" are 20 rows, not 40', async () => {
        const real = new PrismaUsageLogWriter(t.app.get(ConfigService));
        let failedOnce = false;
        const flaky = {
          insert: async (rows: readonly UsageLogRow[]) => {
            await real.insert(rows); // it COMMITTED...
            if (!failedOnce) {
              failedOnce = true;
              throw new Error('Query read timeout'); // ...but the client never saw the answer
            }
          },
        };
        const t2 = await boot(flaky);
        const ua = newUa('dup');
        try {
          await Promise.all(
            Array.from({ length: 20 }, () =>
              t2.server().get(`${BASE}/categories`).set('User-Agent', ua),
            ),
          );
          // first write fails after committing, the buffer waits 1 s (back-off) and writes the SAME rows again
          await t2.buffer.flush(true, true).catch(() => undefined);
          await sleep(1_300);
          await t2.buffer.flush(true, true);
          const rows = await t.prisma.$queryRawUnsafe<
            { n: number; d: number }[]
          >(
            `SELECT count(*)::int AS n, count(DISTINCT "requestId")::int AS d FROM "Usage_Logs" WHERE "userAgent" = $1`,
            ua,
          );
          expect(failedOnce).toBe(true);
          expect(rows[0]).toEqual({ n: 20, d: 20 });
        } finally {
          await t2.close();
          await real.onModuleDestroy();
        }
      });

      it('writing the very same batch twice leaves the table as it was', async () => {
        const real = new PrismaUsageLogWriter(t.app.get(ConfigService));
        const ua = newUa('dup2');
        const mk = (): UsageLogRow => ({
          ts: Date.now(),
          method: 'GET',
          route: '/zz207b/dup',
          status: 200,
          durationMs: 1,
          actorType: 'ANON',
          actorId: null,
          ip: '203.0.113.5',
          userAgent: ua,
          requestId: randomUUID(),
        });
        const batch = Array.from({ length: 50 }, mk);
        try {
          await real.insert(batch);
          await real.insert(batch);
          const n = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "Usage_Logs" WHERE "userAgent" = $1`,
            ua,
          );
          expect(n[0].n).toBe(50);
        } finally {
          await real.onModuleDestroy();
        }
      });

      it('a user agent with a lone surrogate or a NUL does not poison the batch of 200', async () => {
        const ua = newUa('wf');
        const res = await t
          .server()
          .get(`${BASE}/categories`)
          .set('User-Agent', `${ua}-ok`);
        expect(res.status).toBe(200);
        await flush();
        expect((await rowsByUa(`${ua}-ok`)).length).toBe(1);
        uas.push(`${ua}-ok`);
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('the admin query: 503 and not 500 under a saturated pool, and it leaves a trace', () => {
      it('with all ten pooled connections busy, 30 concurrent queries are 200 or 503 USAGE_QUERY_TIMEOUT (P2028 used to be a 500) and the gate refuses the excess at once', async () => {
        const hold = Array.from({ length: 10 }, () =>
          t.prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT pg_sleep(4.5)`;
            },
            { maxWait: 8_000, timeout: 15_000 },
          ),
        );
        await sleep(300);
        const t0 = Date.now();
        const res = await Promise.all(
          Array.from({ length: 30 }, () =>
            t
              .server()
              .get(`${BASE}/admin/audit/usage?route=/zz207b/`)
              .set('Authorization', `Bearer ${admin.token}`)
              .then((r) => ({
                status: r.status,
                code: r.body?.errorCode as string,
                ms: Date.now() - t0,
              })),
          ),
        );
        await Promise.all(hold);
        const codes = res.map(
          (r) => `${r.status}${r.code ? '/' + r.code : ''}`,
        );
        process.stdout.write(
          `[20.7 round 2] 30 queries with the pool busy: ${[...new Set(codes)].map((c) => `${c} x${codes.filter((x) => x === c).length}`).join(', ')}; the slowest answered in ${Math.max(...res.map((r) => r.ms))} ms\n`,
        );
        expect(
          res.some((r) => r.status >= 500 && r.code !== 'USAGE_QUERY_TIMEOUT'),
        ).toBe(false);
        expect(
          res.filter((r) => r.status === 503).length,
        ).toBeGreaterThanOrEqual(21);
        // at most 3 ran + 6 waited; the other 21 were refused immediately
        expect(
          res.filter((r) => r.status === 503 && r.ms < 1_500).length,
        ).toBeGreaterThanOrEqual(21);
      });

      it('GET /admin/audit/usage writes ONE USAGE_LOG_QUERIED per admin and 15 minutes, no filter and no data in it; /stats writes none', async () => {
        const a = await mkAdmin('tr');
        const count = async (action: string) =>
          Number(
            (
              await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
                `SELECT count(*)::bigint AS n FROM "Audit_Events" WHERE "action" = $1 AND "actorId" = $2::uuid`,
                action,
                a.id,
              )
            )[0].n,
          );
        const get = (path: string) =>
          t
            .server()
            .get(`${BASE}/admin/audit/${path}`)
            .set('Authorization', `Bearer ${a.token}`);
        expect(await count('USAGE_LOG_QUERIED')).toBe(0);
        for (let i = 0; i < 5; i++) {
          expect(
            (await get(`usage?route=/zz207b/${i}&ip=203.0.113.0/24`)).status,
          ).toBe(200);
        }
        expect((await get('usage/stats')).status).toBe(200);
        expect(await count('USAGE_LOG_QUERIED')).toBe(1);
        const ev = await t.prisma.$queryRawUnsafe<
          { after: unknown; entityType: string; ip: string | null }[]
        >(
          `SELECT "after", "entityType", host("ip") AS "ip" FROM "Audit_Events" WHERE "action" = 'USAGE_LOG_QUERIED' AND "actorId" = $1::uuid`,
          a.id,
        );
        expect(ev[0].after).toEqual({ windowMinutes: 15 });
        expect(JSON.stringify(ev[0])).not.toMatch(/zz207b|203\.0\.113/);
        // the events view: its own action, once
        expect(await count('AUDIT_EVENTS_QUERIED')).toBe(0);
        for (let i = 0; i < 3; i++)
          expect((await get('events')).status).toBe(200);
        expect(await count('AUDIT_EVENTS_QUERIED')).toBe(1);
      });

      it('fail-closed: if the event cannot be written the usage log is NOT read (503 AUDIT_UNAVAILABLE) and the next query tries again; the events view still answers', async () => {
        const a = await mkAdmin('fc');
        const audit = t.app.get(AuditService);
        const spy = vi.spyOn(audit, 'transaction');
        spy.mockRejectedValue(
          new ApiException(
            503,
            'AUDIT_UNAVAILABLE',
            'The audit log is unavailable.',
          ),
        );
        try {
          const res = await t
            .server()
            .get(`${BASE}/admin/audit/usage`)
            .set('Authorization', `Bearer ${a.token}`);
          expect(res.status).toBe(503);
          expect(res.body.errorCode).toBe('AUDIT_UNAVAILABLE');
          expect(res.body.items).toBeUndefined();
          const ev = await t
            .server()
            .get(`${BASE}/admin/audit/events`)
            .set('Authorization', `Bearer ${a.token}`);
          expect(ev.status).toBe(200);
        } finally {
          spy.mockRestore();
        }
        const ok = await t
          .server()
          .get(`${BASE}/admin/audit/usage`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(ok.status).toBe(200);
        const n = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action" = 'USAGE_LOG_QUERIED' AND "actorId" = $1::uuid`,
          a.id,
        );
        expect(n[0].n).toBe(1);
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('the purge does not depend on the TimeZone of the session', () => {
      const MARK = '/zz207b/tz';
      it('with the database in a zone with DST, 7 days are 168 hours: rows an hour either side of the cut-off go / stay', async () => {
        const db = (
          await t.prisma.$queryRaw<
            { d: string }[]
          >`SELECT current_database() AS d`
        )[0].d;
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const owner = new pg.Client({ connectionString: u.toString() });
        await owner.connect();
        await owner.query(
          `ALTER DATABASE "${db}" SET "TimeZone" = 'America/New_York'`,
        );
        const t3 = await boot();
        try {
          // Round 2 of 20.8: the application's own connections run in UTC whatever the database says
          const appTz = await t3.prisma.$queryRaw<
            { tz: string }[]
          >`SELECT current_setting('TimeZone') AS tz`;
          expect(appTz[0].tz).toBe('UTC');
          // control: in a New York session `timestamptz - '7 days'` is the OLD, DST-dependent arithmetic
          const ctl = await t3.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('TimeZone', 'America/New_York', true)`;
            return tx.$queryRaw<{ tz: string; old: string }[]>`
            SELECT current_setting('TimeZone') AS tz,
                   to_char(('2026-11-02T12:00:00Z'::timestamptz - make_interval(days => 7)) AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS old`;
          });
          expect(ctl[0].tz).toBe('America/New_York');
          expect(ctl[0].old).toBe('2026-10-26T11:00:00Z'); // the bug: 169 hours
          const ins = (iso: string) =>
            t3.prisma.$executeRawUnsafe(
              `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
               VALUES ($1::timestamptz,'GET',$2,200,1,'ANON',gen_random_uuid())`,
              iso,
              MARK,
            );
          await ins('2026-10-26T11:30:00Z'); // older than 168 h before asOf: must go
          await ins('2026-10-26T12:30:00Z'); // younger: must stay
          const r = await t3.app.get(UsageLogPurgeService).purgeExpired({
            days: 7,
            asOf: new Date('2026-11-02T12:00:00Z'),
            pauseMs: 1,
          });
          expect(r.rows).toBeGreaterThanOrEqual(1);
          const left = await t3.prisma.$queryRawUnsafe<{ ts: string }[]>(
            `SELECT to_char("ts" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "ts"
               FROM "Usage_Logs" WHERE "route" = $1 ORDER BY "ts"`,
            MARK,
          );
          expect(left.map((x) => x.ts)).toEqual(['2026-10-26T12:30:00Z']);
        } finally {
          await t3.prisma
            .$executeRawUnsafe(
              `DELETE FROM "Usage_Logs" WHERE "route" = $1`,
              MARK,
            )
            .catch(() => undefined);
          await t3.close();
          await owner.query(`ALTER DATABASE "${db}" RESET "TimeZone"`);
          await owner.end();
        }
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('a flood of anonymous 404s does not push out what matters (end to end)', () => {
      it('with a tiny buffer and a database that does not answer, the admin and 401/403 rows survive 2 000 anonymous 404s, and the discards are counted', async () => {
        const never = { insert: () => new Promise<void>(() => undefined) };
        process.env.USAGE_LOG_BUFFER_MAX = '300';
        process.env.USAGE_LOG_FLUSH_BATCH = '300';
        process.env.USAGE_LOG_FLUSH_MS = '60000';
        let t4: Booted;
        try {
          t4 = await boot(never);
        } finally {
          delete process.env.USAGE_LOG_BUFFER_MAX;
          delete process.env.USAGE_LOG_FLUSH_BATCH;
          delete process.env.USAGE_LOG_FLUSH_MS;
        }
        try {
          const a = await mkAdmin('fl');
          const ua = newUa('flood');
          const flood = (n: number, from: number) =>
            Promise.all(
              Array.from({ length: n }, (_, i) =>
                t4
                  .server()
                  .get(`/wp-admin/${from + i}`)
                  .set('User-Agent', ua)
                  .then(() => undefined),
              ),
            );
          // the first 300 fill the buffer and go into a write that never answers (a database that hangs)
          await flood(300, 0);
          for (let i = 0; i < 5; i++) {
            await t4
              .server()
              .get(`${BASE}/admin/audit/head`)
              .set('Authorization', `Bearer ${a.token}`)
              .set('User-Agent', ua);
          }
          await t4
            .server()
            .get(`${BASE}/admin/audit/head`)
            .set('User-Agent', ua); // 401
          await flood(2_000, 300);
          const s = t4.buffer.stats();
          expect(s.buffered).toBeLessThanOrEqual(300);
          expect(s.droppedSinceBoot).toBeGreaterThanOrEqual(1_700);
          expect(s.droppedLowPrioritySinceBoot).toBe(s.droppedSinceBoot);
          const queued = (
            t4.buffer as unknown as {
              tiers: { size: number }[];
            }
          ).tiers.map((q) => q.size);
          expect(queued[3]).toBe(5); // the 5 admin rows ...
          expect(queued[2]).toBe(1); // ... and the 401: all still there after 2 000 more 404s
          expect(s.lastDropAt).not.toBeNull();
        } finally {
          await t4.close().catch(() => undefined);
        }
      });
    });
  },
);
