/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies and raw rows are untyped JSON */
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SchedulerRegistry } from '@nestjs/schedule';
import { UsageLogPurgeService } from './../src/usage/usage-purge.service.js';
import { RetentionService } from './../src/retention/retention.service.js';
import { RETENTION_ADVISORY_KEY } from './../src/retention/retention.types.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';
import { blockAuditAction } from './helpers/block-audit-action.js';
import { withBuyerId } from './helpers/buyer-id.js';

/**
 * Story 20.8 (FR-130..132, AD-101), against the real database (a throw-away clone: see
 * test/helpers/global-test-db.ts), with the application running as the LIMITED role when the suite is run
 * that way. Every row it seeds carries the tag of this run (`e2e-ret-<TAG>`) and is removed at the end;
 * the file runs in any order. The database clock (`now()`) is the only clock: every date is seeded
 * relative to it, never from the process clock.
 */
const BASE = '/api/v1';
const TAG = randomUUID().replace(/-/g, '').slice(0, 8);
const MARK = `e2e-ret-${TAG}`;
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97';
const MTG_TIN_ID = 'c1701d9e-5fd2-4083-98f2-ce751d7ed64b';

interface Booted {
  app: NestExpressApplication;
  prisma: PrismaService;
  svc: RetentionService;
  base: string;
  server: () => request.Agent;
  close: () => Promise<void>;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const merged: Record<string, string> = {
    RETENTION_PURGE_ENABLED: 'true',
    RETENTION_BATCH_SIZE: '10',
    RETENTION_BATCH_PAUSE_MS: '0',
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    saved[k] = process.env[k];
    if (v === '__unset__') delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.set('trust proxy', 1);
    applyRequestContext(app);
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
    await app.init();
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    return {
      app,
      prisma: app.get(PrismaService),
      svc: app.get(RetentionService),
      base,
      server: () => request.agent(base),
      close: () => app.close(),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Naive-UTC timestamp `interval` ago, from the DATABASE clock (the columns are `timestamp without time zone`). */
const ago = (interval: string) =>
  `((now() AT TIME ZONE 'UTC') - interval '${interval}')`;
const ahead = (interval: string) =>
  `((now() AT TIME ZONE 'UTC') + interval '${interval}')`;

const PROTECTED_TABLES = [
  'Orders',
  'Order_Lines',
  'Order_Status_History',
  'Order_Tracking_Events',
  'Stock_Holds',
  'Proof_Of_Payments',
  'Consent_Records',
  'Stripe_Webhook_Events',
  'Customers',
  'Customer_Addresses',
  'Customer_Accounts',
  'Admin_Users',
  'Products',
  'Legal_Documents',
  'Legal_Document_Versions',
  'Legal_Drafts',
  'Legal_Audit_Logs',
];

describe('Retention job (e2e, Story 20.8)', { timeout: 120_000 }, () => {
  let t: Booted;
  let admin: { id: string; token: string };
  let customerId: string;
  let productIds: string[];
  const customers: string[] = [];
  const orders: string[] = [];

  const q = <R = Record<string, unknown>>(
    query: string,
    ...params: unknown[]
  ): Promise<R[]> => t.prisma.$queryRawUnsafe<R[]>(query, ...params);
  const x = (query: string, ...params: unknown[]): Promise<number> =>
    t.prisma.$executeRawUnsafe(query, ...params);

  const post = (path: string, body?: object) =>
    t
      .server()
      .post(`${BASE}${path}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(body ?? {});
  const get = (path: string) =>
    t
      .server()
      .get(`${BASE}${path}`)
      .set('Authorization', `Bearer ${admin.token}`);

  /** POST /admin/retention/run and wait until the run it started has finished. */
  async function runAndWait(): Promise<{
    runId: string;
    run: Record<string, any>;
    byTask: Record<
      string,
      { rows: number; truncated: boolean; error?: string }
    >;
  }> {
    const res = await post('/admin/retention/run').expect(202);
    const runId = res.body.runId as string;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    return { runId, ...(await waitRun(runId)) };
  }
  async function waitRun(runId: string) {
    for (let i = 0; i < 600; i++) {
      const rows = await q<Record<string, any>>(
        `SELECT * FROM "Retention_Runs" WHERE "id" = $1::uuid`,
        runId,
      );
      if (rows[0] && rows[0].status !== 'RUNNING') {
        const tasks = rows[0].tasks as {
          name: string;
          rows: number;
          truncated: boolean;
          error?: string;
        }[];
        return {
          run: rows[0],
          byTask: Object.fromEntries(tasks.map((k) => [k.name, k])),
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} did not finish`);
  }

  const rowCount = async (table: string, where: string): Promise<number> =>
    Number(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`,
        )
      )[0].n,
    );

  /** count + md5 of the whole content of a table (rows as text, in a stable order). */
  const fingerprint = async (table: string, where = 'true') =>
    (
      await q<{ n: string; h: string }>(
        `SELECT count(*)::text AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h
           FROM "${table}" t WHERE ${where}`,
      )
    )[0];

  async function protectedSnapshot(upTo?: number) {
    const head =
      upTo ??
      Number(
        (
          await q<{ s: string }>(
            `SELECT coalesce(max("seq"), 0)::text AS s FROM "Audit_Events"`,
          )
        )[0].s,
      );
    const out: Record<string, { n: string; h: string }> = {};
    for (const tb of PROTECTED_TABLES) out[tb] = await fingerprint(tb);
    out.Audit_Events_before_head = await fingerprint(
      'Audit_Events',
      `"seq" <= ${head}`,
    );
    return { head, out };
  }

  // -------------------------------------------------------------------------------------------------
  // Seeds. Every row says in its own words why it must (or must not) disappear.
  // -------------------------------------------------------------------------------------------------
  interface Seeded {
    sessions: Record<string, string>; // key -> token
    adminSessions: Record<string, string>;
    revoked: Record<string, string>; // key -> jti
    verifications: Record<string, string>; // key -> identifier
    contacts: Record<string, string>; // key -> id
    carts: Record<string, string>; // key -> id
    wishlists: Record<string, string>;
    usage: Record<string, string>; // key -> requestId
    statsOld: string; // productId
    oldRun: string;
    orderId: string;
  }

  async function seed(prefix: string): Promise<Seeded> {
    const s: Seeded = {
      sessions: {},
      adminSessions: {},
      revoked: {},
      verifications: {},
      contacts: {},
      carts: {},
      wishlists: {},
      usage: {},
      statsOld: productIds[0],
      oldRun: randomUUID(),
      orderId: '',
    };
    const tok = (k: string) => `${prefix}-${k}`;
    // Customer sessions: [key, createdAt ago, expiresAt (ago|ahead), ip]
    const cs: [string, string, string][] = [
      ['expiredLong', '100 days', ago('20 days')], // expired > 7 d: deleted
      ['expiredRecentOldCreated', '100 days', ago('3 days')], // kept, PII nulled (created > 90 d, expired)
      ['aliveOld', '100 days', ahead('1 day')], // LIVE: not touched at all
      ['expiredNewCreated', '10 days', ago('2 days')], // expired but young: kept with its PII
      [
        'expiredJustUnderGrace',
        '100 days',
        ago('7 days') + " + interval '30 minutes'",
      ], // expired 6d23h30m: kept (grace + margin)
    ];
    for (const [k, created, expires] of cs) {
      s.sessions[k] = tok(`cs-${k}`);
      await x(
        `INSERT INTO "Customer_Sessions" ("id","token","expiresAt","ipAddress","userAgent","userId","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, ${expires}, '203.0.113.7', 'e2e-agent', $2::uuid, ${ago(created)}, ${ago('1 day')})`,
        s.sessions[k],
        customerId,
      );
    }
    for (const [k, created, expires] of cs.slice(0, 3)) {
      s.adminSessions[k] = tok(`as-${k}`);
      await x(
        `INSERT INTO "Admin_Sessions" ("id","token","expiresAt","ipAddress","userAgent","userId","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, ${expires}, '203.0.113.8', 'e2e-agent', $2::uuid, ${ago(created)}, ${ago('1 day')})`,
        s.adminSessions[k],
        admin.id,
      );
    }
    // Revoked tokens
    for (const [k, expires] of [
      ['old', ago('9 days')],
      ['recent', ago('3 days')],
    ] as const) {
      s.revoked[k] = randomUUID();
      await x(
        `INSERT INTO "Revoked_Tokens" ("jti","expiresAt","revokedAt") VALUES ($1::uuid, ${expires}, ${ago('10 days')})`,
        s.revoked[k],
      );
    }
    // Verification / reset links
    for (const [k, expires] of [
      ['expiredLong', ago('3 days')], // deleted (1 day past expiry by default)
      ['expiredHoursAgo', ago('2 hours')], // kept
      ['valid', ahead('1 hour')], // never
    ] as const) {
      s.verifications[k] = tok(`v-${k}`);
      await x(
        `INSERT INTO "Customer_Verifications" ("id","identifier","value","expiresAt","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, ${expires}, ${ago('4 days')}, ${ago('4 days')})`,
        s.verifications[k],
        customerId,
      );
    }
    // Contact messages
    for (const [k, created] of [
      ['old13m', '13 months'],
      ['recent11m', '11 months'],
      ['boundary', '12 months 10 minutes'], // older than 12 months but inside the safety margin: kept
    ] as const) {
      s.contacts[k] = randomUUID();
      await x(
        `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
         VALUES ($1::uuid, $2, $3, 'e2e synthetic message', ${ago(created)}, ${ago(created)})`,
        s.contacts[k],
        tok(`contact-${k}`),
        `${tok(`c-${k}`)}@212collectorsclub.test`,
      );
    }
    // Anonymous carts and wishlists (+ lines), and the same dates on an ACCOUNT's
    const baskets: [string, string, boolean][] = [
      ['expiredLong', ago('45 days'), false], // deleted with its lines
      ['expiredJustNow', ago('10 minutes'), false], // inside the margin: kept
      ['valid', ahead('10 days'), false], // never
    ];
    for (const [k, expires] of baskets) {
      const cid = (s.carts[k] = randomUUID());
      await x(
        `INSERT INTO "Carts" ("id","customerId","expiresAt","createdAt","updatedAt") VALUES ($1::uuid, NULL, ${expires}, ${ago('50 days')}, ${ago('50 days')})`,
        cid,
      );
      for (const pid of productIds.slice(0, 2)) {
        await x(
          `INSERT INTO "Cart_Items" ("id","cartId","productId","quantity","createdAt","updatedAt") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, now(), now())`,
          cid,
          pid,
        );
      }
      const wid = (s.wishlists[k] = randomUUID());
      await x(
        `INSERT INTO "Wishlists" ("id","customerId","expiresAt","createdAt","updatedAt") VALUES ($1::uuid, NULL, ${expires}, ${ago('50 days')}, ${ago('50 days')})`,
        wid,
      );
      await x(
        `INSERT INTO "Wishlist_Items" ("id","wishlistId","productId","createdAt") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, now())`,
        wid,
        productIds[0],
      );
    }
    // Usage log
    for (const [k, ts] of [
      ['old8d', '8 days'],
      ['recent6d', '6 days'],
    ] as const) {
      s.usage[k] = randomUUID();
      await x(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","ip","userAgent","requestId")
         VALUES (now() - interval '${ts}', 'GET', '/${MARK}', 200, 5, 'ANON', '203.0.113.9', 'e2e-agent', $1::uuid)`,
        s.usage[k],
      );
    }
    // Product_Daily_Stats: 200 days old (deleted by the Epic 18 purge) and today's
    await x(
      `INSERT INTO "Product_Daily_Stats" ("productId","day","views","cartAdds") VALUES ($1::uuid, current_date - 200, 5, 1) ON CONFLICT DO NOTHING`,
      s.statsOld,
    );
    // Retention_Runs history older than 400 days
    await x(
      `INSERT INTO "Retention_Runs" ("id","trigger","startedAt","finishedAt","status","tasks","effectiveNow","auditedAt")
       VALUES ($1::uuid, 'SCHEDULED', now() - interval '500 days', now() - interval '500 days', 'OK', '[]', NULL, now() - interval '500 days')`,
      s.oldRun,
    );
    // An OLD order with its cedula (encrypted marker), a proof and a consent: the fiscal record.
    const order = await t.prisma.order.create({
      data: {
        status: 'FULFILLED',
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'DELIVERY',
        recipientName: `${prefix} Buyer`,
        recipientPhone: '0412-0000000',
        recipientIdDocEnc: `v1:${prefix}-cipher-recipient`,
        recipientIdDocBlind: 'a'.repeat(64),
        buyerIdType: 'V',
        buyerIdDocEnc: `v1:${prefix}-cipher-buyer`,
        buyerIdDocBlind: 'b'.repeat(64),
        totalUsd: '10.00',
        accessTokenHash: `${prefix}-${randomUUID()}`.slice(0, 64),
        customerId,
        createdAt: new Date(Date.now() - 800 * 86_400_000),
        lines: {
          create: [
            {
              productId: productIds[0],
              productName: 'e2e line',
              unitPriceUsd: '10.00',
              quantity: 1,
              lineTotalUsd: '10.00',
            },
          ],
        },
        statusHistory: {
          create: [
            { fromStatus: null, toStatus: 'FULFILLED', actorType: 'SYSTEM' },
          ],
        },
        consents: {
          create: [
            {
              type: 'AGE_DECLARATION',
              version: 0,
              context: 'CHECKOUT',
              customerId,
            },
          ],
        },
        proofOfPayments: {
          create: [
            {
              filePath: `e2e/${prefix}.png`,
              mimeType: 'image/png',
              sizeBytes: 12,
            },
          ],
        },
      },
    });
    orders.push(order.id);
    s.orderId = order.id;
    return s;
  }

  async function cleanup(prefix: string, s: Seeded | null) {
    await x(
      `DELETE FROM "Customer_Sessions" WHERE "token" LIKE $1`,
      `${prefix}%`,
    );
    await x(`DELETE FROM "Admin_Sessions" WHERE "token" LIKE $1`, `${prefix}%`);
    await x(
      `DELETE FROM "Customer_Verifications" WHERE "identifier" LIKE $1`,
      `${prefix}%`,
    );
    await x(
      `DELETE FROM "Contact_Inquiries" WHERE "name" LIKE $1`,
      `${prefix}%`,
    );
    await x(`DELETE FROM "Usage_Logs" WHERE "route" = $1`, `/${MARK}`);
    if (s) {
      await x(
        `DELETE FROM "Revoked_Tokens" WHERE "jti" = ANY($1::uuid[])`,
        Object.values(s.revoked),
      );
      await x(
        `DELETE FROM "Carts" WHERE "id" = ANY($1::uuid[])`,
        Object.values(s.carts),
      );
      await x(
        `DELETE FROM "Wishlists" WHERE "id" = ANY($1::uuid[])`,
        Object.values(s.wishlists),
      );
      await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, s.oldRun);
    }
  }

  beforeAll(async () => {
    t = await boot();
    const a = await t.prisma.adminUser.create({
      data: {
        username: `${MARK}-admin`,
        email: `${MARK}-admin@212collectorsclub.test`,
        passwordHash: 'x',
      },
    });
    admin = { id: a.id, token: await mintAdminToken(t.app, a.id) };
    const c = await t.prisma.customer.create({
      data: {
        email: `${MARK}-cust@212collectorsclub.test`,
        name: 'Retention Tester',
      },
    });
    customerId = c.id;
    customers.push(c.id);
    productIds = (
      await t.prisma.product.findMany({
        take: 3,
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).map((p) => p.id);
    expect(productIds.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    await x(
      `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
      admin.id,
    ).catch(() => 0);
    await cleanup(MARK, null).catch(() => undefined);
    for (const id of orders)
      await t.prisma.order.delete({ where: { id } }).catch(() => undefined);
    for (const id of customers)
      await t.prisma.customer.delete({ where: { id } }).catch(() => undefined);
    await t.prisma.adminUser
      .delete({ where: { id: admin.id } })
      .catch(() => undefined);
    await t.close();
  });

  // =================================================================================================
  describe('who may run it, and where', () => {
    it('401 without a token on the three routes', async () => {
      await t.server().post(`${BASE}/admin/retention/run`).send({}).expect(401);
      await t.server().get(`${BASE}/admin/retention/runs`).expect(401);
      await t.server().get(`${BASE}/admin/retention/config`).expect(401);
    });

    it('GET /runs: 400 on a bad limit, 200 otherwise', async () => {
      for (const bad of ['0', '101', 'abc', '1.5', '-3']) {
        await get(`/admin/retention/runs?limit=${bad}`).expect(400);
      }
      const ok = await get('/admin/retention/runs?limit=5').expect(200);
      expect(ok.body).toMatchObject({ limit: 5, running: false });
      expect(Array.isArray(ok.body.items)).toBe(true);
    });

    it('GET /config: the periods in force, the next run, and what is never purged', async () => {
      const res = await get('/admin/retention/config').expect(200);
      expect(res.body).toMatchObject({
        enabled: true,
        cron: '30 4 * * *',
        batchSize: 10,
        safetyMarginMinutes: 60,
        maxClockAdvanceHours: 72,
        periods: {
          sessionPiiDays: 90,
          expiredSessionDays: 7,
          contactMonths: 12,
          usageLogDays: 7,
          productDailyStatsDays: 180,
          anonymousBasketsAtExpiry: true,
        },
      });
      expect(res.body.tasks).toEqual([
        'sessions_expired',
        'session_pii',
        'revoked_tokens',
        'verification_tokens',
        'contact_inquiries',
        'anon_carts',
        'anon_wishlists',
        'product_daily_stats',
        'retention_runs',
        'usage_logs',
      ]);
      expect((res.body.neverPurged as string[]).join(' ')).toMatch(
        /Orders.*cedula/,
      );
      expect((res.body.neverPurged as string[]).join(' ')).toMatch(
        /Proof_Of_Payments/,
      );
      expect((res.body.neverPurged as string[]).join(' ')).toMatch(
        /Consent_Records/,
      );
      expect((res.body.neverPurged as string[]).join(' ')).toMatch(
        /Audit_Events/,
      );
    });

    it('the run takes NO parameter: a body with any property is 400 and nothing runs', async () => {
      const before = await rowCount('Retention_Runs', 'true');
      for (const body of [
        { days: 0 },
        { olderThanDays: 0 },
        { dryRun: true },
        { now: '2999-01-01T00:00:00Z' },
      ]) {
        await post('/admin/retention/run', body).expect(400);
      }
      expect(await rowCount('Retention_Runs', 'true')).toBe(before);
    });

    it('a query string cannot move a period either', async () => {
      const s = await seed(`${MARK}-q`);
      try {
        const res = await t
          .server()
          .post(
            `${BASE}/admin/retention/run?days=0&months=0&sessionPiiDays=1&asOf=2999-01-01`,
          )
          .set('Authorization', `Bearer ${admin.token}`)
          .send({})
          .expect(202);
        await waitRun(res.body.runId as string);
        // the 11-month contact message and the young expired session are untouched
        expect(
          await rowCount(
            'Contact_Inquiries',
            `"id" = '${s.contacts.recent11m}'`,
          ),
        ).toBe(1);
        expect(
          await rowCount(
            'Customer_Sessions',
            `"token" = '${s.sessions.expiredNewCreated}'`,
          ),
        ).toBe(1);
      } finally {
        await cleanup(`${MARK}-q`, s);
      }
    });

    it('disabled (not production, not asked for): 409 RETENTION_DISABLED, no row, no lock', async () => {
      const off = await boot({ RETENTION_PURGE_ENABLED: '__unset__' });
      try {
        const before = await rowCount('Retention_Runs', 'true');
        const token = await mintAdminToken(off.app, admin.id);
        const res = await off
          .server()
          .post(`${BASE}/admin/retention/run`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(409);
        expect(res.body.errorCode).toBe('RETENTION_DISABLED');
        await off.svc.scheduled(); // the cron path does nothing either
        expect(await rowCount('Retention_Runs', 'true')).toBe(before);
        const cfg = await off
          .server()
          .get(`${BASE}/admin/retention/config`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(cfg.body.enabled).toBe(false);
        expect(cfg.body.nextRunAt).toBeNull();
      } finally {
        await off.close();
      }
    });

    it('Swagger documents every route with its errorCode (/api/docs-json)', async () => {
      const res = await t.server().get('/api/docs-json').expect(200);
      const paths = res.body.paths as Record<
        string,
        Record<
          string,
          {
            responses: Record<string, { description?: string }>;
            security?: unknown[];
          }
        >
      >;
      const run = paths[`${BASE}/admin/retention/run`].post;
      expect(Object.keys(run.responses)).toEqual(
        expect.arrayContaining(['202', '400', '401', '409']),
      );
      expect(run.responses['409'].description).toMatch(
        /RETENTION_ALREADY_RUNNING/,
      );
      expect(run.responses['409'].description).toMatch(/RETENTION_DISABLED/);
      expect(run.responses['401'].description).toBe('INVALID_ADMIN_TOKEN');
      expect(run.security).toBeDefined();
      const runs = paths[`${BASE}/admin/retention/runs`].get;
      expect(Object.keys(runs.responses)).toEqual(
        expect.arrayContaining(['200', '400', '401']),
      );
      const cfg = paths[`${BASE}/admin/retention/config`].get;
      expect(Object.keys(cfg.responses)).toEqual(
        expect.arrayContaining(['200', '401']),
      );
    });

    it('ONE schedule for the usage log: the retention job. UsageLogPurgeService has no cron (USAGE_LOG_PURGE_CRON is ignored) and the job is registered from the validated configuration', async () => {
      const jobs = (app: NestExpressApplication) =>
        [...app.get(SchedulerRegistry).getCronJobs().keys()].filter((n) =>
          /usage|retention/.test(n),
        );
      expect('scheduled' in t.app.get(UsageLogPurgeService)).toBe(false);
      // job enabled, valid cron: exactly the retention job
      expect(jobs(t.app)).toEqual(['retention-purge']);
      // the old per-service cron set, job DISABLED: nobody schedules, nothing is purged
      const rid = randomUUID();
      await x(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId") VALUES (now() - interval '9 days','GET','/${MARK}',200,1,'ANON',$1::uuid)`,
        rid,
      );
      try {
        const legacy = await boot({
          RETENTION_PURGE_ENABLED: 'false',
          USAGE_LOG_PURGE_CRON: '* * * * * *',
        });
        try {
          expect(jobs(legacy.app)).toEqual([]);
          await new Promise((r) => setTimeout(r, 2_500));
          expect(await rowCount('Usage_Logs', `"requestId" = '${rid}'`)).toBe(
            1,
          );
          await legacy.svc.scheduled(); // disabled: a tick does nothing either
          expect(await rowCount('Usage_Logs', `"requestId" = '${rid}'`)).toBe(
            1,
          );
        } finally {
          await legacy.close();
        }
        // job enabled with the cron OFF: no schedule at all (the production boot logs a WARN), and the old variable changes nothing
        const off = await boot({
          RETENTION_PURGE_CRON: 'off',
          USAGE_LOG_PURGE_CRON: '* * * * * *',
        });
        try {
          expect(jobs(off.app)).toEqual([]);
          expect(off.svc.nextRunAt()).toBeNull();
          await new Promise((r) => setTimeout(r, 2_500));
          expect(await rowCount('Usage_Logs', `"requestId" = '${rid}'`)).toBe(
            1,
          );
        } finally {
          await off.close();
        }
      } finally {
        await x(`DELETE FROM "Usage_Logs" WHERE "requestId" = $1::uuid`, rid);
      }
    });

    it('GET /config shows the cron that is really registered (set after the modules were imported), and so does the next run', async () => {
      const custom = await boot({ RETENTION_PURGE_CRON: '15 2 * * *' });
      try {
        const res = await custom
          .server()
          .get(`${BASE}/admin/retention/config`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(200);
        expect(res.body.cron).toBe('15 2 * * *');
        const next = new Date(res.body.nextRunAt as string);
        expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([2, 15]);
        const registered = custom.app
          .get(SchedulerRegistry)
          .getCronJob('retention-purge');
        expect(String(registered.cronTime.source)).toBe('15 2 * * *');
      } finally {
        await custom.close();
      }
    });

    it('an invalid period stops the application from starting, naming the variable', async () => {
      for (const [name, value] of [
        ['PURGE_SESSION_PII_DAYS', '29'],
        ['PURGE_CONTACT_MONTHS', '2'],
        ['PURGE_USAGE_LOG_DAYS', '0'],
        ['PURGE_USAGE_LOG_DAYS', '8'], // the Privacy Policy promises 7
        ['RETENTION_BATCH_SIZE', '5000'],
        ['RETENTION_PURGE_CRON', '61 99 * * *'], // used to stop the start with a bare CronError
      ] as const) {
        await expect(boot({ [name]: value })).rejects.toThrow(new RegExp(name));
      }
    });
  });

  // =================================================================================================
  describe('what a run deletes, what it keeps, and that it is idempotent (AC2, AC3, AC4)', () => {
    it('purges every task exactly as the periods say, never touches the fiscal record, and the second run affects 0 rows', async () => {
      const s = await seed(`${MARK}-a`);
      const protectedBefore = await protectedSnapshot();
      const swapStatsRow = await rowCount(
        'Product_Daily_Stats',
        `"productId" = '${s.statsOld}' AND "day" = current_date - 200`,
      );
      expect(swapStatsRow).toBe(1);
      try {
        const first = await runAndWait();
        expect(first.run.status).toBe('OK');
        expect(first.run.trigger).toBe('MANUAL');
        expect(first.run.triggeredById).toBe(admin.id);
        expect(first.run.auditedAt).not.toBeNull();
        expect(first.run.effectiveNow).not.toBeNull();
        for (const name of t.svc.taskNames()) {
          expect(first.byTask[name], name).toBeDefined();
          expect(first.byTask[name].error, name).toBeUndefined();
          expect(first.byTask[name].truncated, name).toBe(false);
        }

        const has = (table: string, col: string, v: string) =>
          rowCount(table, `"${col}" = '${v}'`);
        // --- sessions_expired / session_pii
        expect(
          await has('Customer_Sessions', 'token', s.sessions.expiredLong),
        ).toBe(0);
        expect(
          await has(
            'Customer_Sessions',
            'token',
            s.sessions.expiredRecentOldCreated,
          ),
        ).toBe(1);
        expect(
          await has(
            'Customer_Sessions',
            'token',
            s.sessions.expiredJustUnderGrace,
          ),
        ).toBe(1);
        expect(
          await has('Admin_Sessions', 'token', s.adminSessions.expiredLong),
        ).toBe(0);
        const pii = async (table: string, token: string) =>
          (
            await q<{ ip: string | null; ua: string | null }>(
              `SELECT "ipAddress" AS ip, "userAgent" AS ua FROM "${table}" WHERE "token" = $1`,
              token,
            )
          )[0];
        expect(
          await pii('Customer_Sessions', s.sessions.expiredRecentOldCreated),
        ).toEqual({ ip: null, ua: null });
        expect(
          await pii('Admin_Sessions', s.adminSessions.expiredRecentOldCreated),
        ).toEqual({ ip: null, ua: null });
        // the LIVE session of a 100-day-old login keeps everything, and so does a young expired one
        expect(await pii('Customer_Sessions', s.sessions.aliveOld)).toEqual({
          ip: '203.0.113.7',
          ua: 'e2e-agent',
        });
        expect(await pii('Admin_Sessions', s.adminSessions.aliveOld)).toEqual({
          ip: '203.0.113.8',
          ua: 'e2e-agent',
        });
        expect(
          await pii('Customer_Sessions', s.sessions.expiredNewCreated),
        ).toEqual({ ip: '203.0.113.7', ua: 'e2e-agent' });
        // --- revoked tokens and links
        expect(await has('Revoked_Tokens', 'jti', s.revoked.old)).toBe(0);
        expect(await has('Revoked_Tokens', 'jti', s.revoked.recent)).toBe(1);
        expect(
          await has(
            'Customer_Verifications',
            'identifier',
            s.verifications.expiredLong,
          ),
        ).toBe(0);
        expect(
          await has(
            'Customer_Verifications',
            'identifier',
            s.verifications.expiredHoursAgo,
          ),
        ).toBe(1);
        expect(
          await has(
            'Customer_Verifications',
            'identifier',
            s.verifications.valid,
          ),
        ).toBe(1);
        // --- contact messages: 12 months, with the margin
        expect(await has('Contact_Inquiries', 'id', s.contacts.old13m)).toBe(0);
        expect(await has('Contact_Inquiries', 'id', s.contacts.recent11m)).toBe(
          1,
        );
        expect(await has('Contact_Inquiries', 'id', s.contacts.boundary)).toBe(
          1,
        );
        // --- anonymous carts / wishlists and their lines
        expect(await has('Carts', 'id', s.carts.expiredLong)).toBe(0);
        expect(await has('Cart_Items', 'cartId', s.carts.expiredLong)).toBe(0);
        expect(await has('Carts', 'id', s.carts.expiredJustNow)).toBe(1);
        expect(await has('Cart_Items', 'cartId', s.carts.expiredJustNow)).toBe(
          2,
        );
        expect(await has('Carts', 'id', s.carts.valid)).toBe(1);
        expect(await has('Wishlists', 'id', s.wishlists.expiredLong)).toBe(0);
        expect(
          await has('Wishlist_Items', 'wishlistId', s.wishlists.expiredLong),
        ).toBe(0);
        expect(await has('Wishlists', 'id', s.wishlists.expiredJustNow)).toBe(
          1,
        );
        expect(await has('Wishlists', 'id', s.wishlists.valid)).toBe(1);
        // --- usage log, daily stats, own history
        expect(await has('Usage_Logs', 'requestId', s.usage.old8d)).toBe(0);
        expect(await has('Usage_Logs', 'requestId', s.usage.recent6d)).toBe(1);
        expect(
          await rowCount(
            'Product_Daily_Stats',
            `"productId" = '${s.statsOld}' AND "day" = current_date - 200`,
          ),
        ).toBe(0);
        expect(await has('Retention_Runs', 'id', s.oldRun)).toBe(0);
        expect(await has('Retention_Runs', 'id', first.runId)).toBe(1);
        // the counters of the run include what was seeded (the clone may hold more expired rows from other suites)
        expect(first.byTask.sessions_expired.rows).toBeGreaterThanOrEqual(2);
        expect(first.byTask.anon_carts.rows).toBeGreaterThanOrEqual(1);
        expect(first.byTask.usage_logs.rows).toBeGreaterThanOrEqual(1);
        expect(first.byTask.contact_inquiries.rows).toBeGreaterThanOrEqual(1);
        expect(first.byTask.session_pii.rows).toBeGreaterThanOrEqual(2);

        // --- THE FISCAL RECORD IS BYTE-IDENTICAL (AC3): count and md5 of every row, per table
        const protectedAfter = await protectedSnapshot(protectedBefore.head);
        for (const tb of Object.keys(protectedBefore.out)) {
          expect(protectedAfter.out[tb], `${tb} changed`).toEqual(
            protectedBefore.out[tb],
          );
        }
        const order = (
          await q<{ enc: string; buyer: string }>(
            `SELECT "recipientIdDocEnc" AS enc, "buyerIdDocEnc" AS buyer FROM "Orders" WHERE "id" = $1::uuid`,
            s.orderId,
          )
        )[0];
        expect(order).toEqual({
          enc: `v1:${MARK}-a-cipher-recipient`,
          buyer: `v1:${MARK}-a-cipher-buyer`,
        });
        // Audit_Events: the old rows are untouched and the run added exactly ITS events (RETENTION_PURGE_RUN)
        const added = await q<{
          action: string;
          entityId: string;
          after: Record<string, any>;
          actorType: string;
          actorId: string;
        }>(
          `SELECT "action","entityId","after","actorType","actorId"::text FROM "Audit_Events" WHERE "seq" > $1 ORDER BY "seq"`,
          protectedBefore.head,
        );
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          action: 'RETENTION_PURGE_RUN',
          entityId: first.runId,
          actorType: 'ADMIN',
          actorId: admin.id,
        });
        expect(added[0].after).toMatchObject({
          runId: first.runId,
          trigger: 'MANUAL',
          status: 'OK',
          lateAudit: false,
        });
        expect(
          (added[0].after.tasks as { name: string }[]).map((k) => k.name),
        ).toEqual(t.svc.taskNames());
        // counters only: no email, no address, no token anywhere in the event
        expect(JSON.stringify(added[0].after)).not.toMatch(
          /@|203\.0\.113|e2e-agent|cipher|e2e-ret/i,
        );
        expect(
          await fingerprint('Audit_Events', `"seq" <= ${protectedBefore.head}`),
        ).toEqual(protectedBefore.out.Audit_Events_before_head);

        // --- IDEMPOTENT: the second run changes nothing and says 0 rows
        const targets = [
          'Customer_Sessions',
          'Admin_Sessions',
          'Revoked_Tokens',
          'Customer_Verifications',
          'Contact_Inquiries',
          'Carts',
          'Cart_Items',
          'Wishlists',
          'Wishlist_Items',
          'Usage_Logs',
          'Product_Daily_Stats',
        ];
        const stateBefore: Record<string, { n: string; h: string }> = {};
        for (const tb of targets) stateBefore[tb] = await fingerprint(tb);
        const second = await runAndWait();
        expect(second.run.status).toBe('OK');
        for (const name of t.svc.taskNames()) {
          if (name === 'retention_runs') continue;
          expect(second.byTask[name].rows, `second run, ${name}`).toBe(0);
        }
        for (const tb of targets) {
          expect(await fingerprint(tb), `${tb} after the second run`).toEqual(
            stateBefore[tb],
          );
        }
      } finally {
        await cleanup(`${MARK}-a`, s);
      }
    });

    it('the schema cannot cascade a purge into the fiscal record: foreign-key and trigger closure read from the catalog', async () => {
      const purged = [
        'Customer_Sessions',
        'Admin_Sessions',
        'Revoked_Tokens',
        'Customer_Verifications',
        'Contact_Inquiries',
        'Carts',
        'Wishlists',
        'Retention_Runs',
        'Usage_Logs',
        'Product_Daily_Stats',
      ];
      // every table that references a purged table (children), transitively
      const fks = await q<{ child: string; parent: string; ondel: string }>(
        `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, c.confdeltype::text AS ondel
           FROM pg_constraint c WHERE c.contype = 'f'`,
      );
      const unquote = (n: string) => n.replace(/^"|"$/g, '');
      const children = new Map<string, { child: string; ondel: string }[]>();
      for (const f of fks) {
        const p = unquote(f.parent);
        children.set(p, [
          ...(children.get(p) ?? []),
          { child: unquote(f.child), ondel: f.ondel },
        ]);
      }
      const reached = new Set<string>();
      const stack = [...purged];
      while (stack.length) {
        const n = stack.pop()!;
        for (const { child } of children.get(n) ?? []) {
          if (!reached.has(child)) {
            reached.add(child);
            stack.push(child);
          }
        }
      }
      // deleting from a purged table can only ever reach the lines of a cart / wishlist
      expect([...reached].sort()).toEqual(['Cart_Items', 'Wishlist_Items']);
      for (const protectedTable of [
        ...PROTECTED_TABLES,
        'Audit_Events',
        'Audit_Verifications',
      ]) {
        expect(reached.has(protectedTable), protectedTable).toBe(false);
      }
      // nothing pointing at the purged tables restricts or nulls: only CASCADE (c) from carts and wishlists
      for (const p of purged) {
        for (const c of children.get(p) ?? []) expect(c.ondel).toBe('c');
      }
      // and no trigger on a purged table (a trigger could write or delete anywhere)
      const triggers = await q<{ t: string }>(
        `SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
          WHERE NOT g.tgisinternal AND c.relname = ANY($1::text[])`,
        [...purged, 'Cart_Items', 'Wishlist_Items'],
      );
      expect(triggers).toEqual([]);
    });
  });

  // =================================================================================================
  describe('one run at a time (AC1)', () => {
    it('two HTTP runs at once: exactly one is 202, the other 409 RETENTION_ALREADY_RUNNING', async () => {
      const results = await Promise.all([
        post('/admin/retention/run'),
        post('/admin/retention/run'),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([202, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.errorCode).toBe('RETENTION_ALREADY_RUNNING');
      const winner = results.find((r) => r.status === 202)!;
      await waitRun(winner.body.runId as string);
      expect(
        await rowCount(
          'Retention_Runs',
          `"id" = '${winner.body.runId}' AND "status" = 'OK'`,
        ),
      ).toBe(1);
    });

    it('two INSTANCES (two applications, two lock connections) in Promise.all: one runs, the other is "busy" without a 5xx', async () => {
      const other = await boot();
      try {
        const [a, b] = await Promise.all([
          t.svc.start('SCHEDULED'),
          other.svc.start('SCHEDULED'),
        ]);
        const kinds = [a.kind, b.kind].sort();
        expect(kinds).toEqual(['busy', 'started']);
        const winner = (a.kind === 'started' ? a : b) as Extract<
          typeof a,
          { kind: 'started' }
        >;
        const sum = await winner.done;
        expect(sum.status).toBe('OK');
        // never two RUNNING rows, and the lock is free again
        expect(await rowCount('Retention_Runs', `"status" = 'RUNNING'`)).toBe(
          0,
        );
        const again = await t.svc.start('SCHEDULED');
        expect(again.kind).toBe('started');
        if (again.kind === 'started') await again.done;
      } finally {
        await other.close();
      }
    });

    it('while a run is going the cron path of another instance skips quietly, and the lock is the SESSION lock of a dedicated connection', async () => {
      const holder = new pg.Client({ connectionString: urlForLock() });
      await holder.connect();
      try {
        const got = await holder.query(
          'SELECT pg_try_advisory_lock($1::int) AS ok',
          [RETENTION_ADVISORY_KEY],
        );
        expect(got.rows[0].ok).toBe(true);
        const before = await rowCount('Retention_Runs', 'true');
        await t.svc.scheduled(); // busy: nothing, no throw
        expect(await rowCount('Retention_Runs', 'true')).toBe(before);
        await post('/admin/retention/run').expect(409);
        // the lock lives in pg_locks as an advisory lock of a session (not a transaction)
        const locks = await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted`,
          RETENTION_ADVISORY_KEY,
        );
        expect(Number(locks[0].n)).toBe(1);
      } finally {
        await holder.end(); // dying connection releases it
      }
      const ok = await post('/admin/retention/run').expect(202);
      await waitRun(ok.body.runId as string);
    });

    it('a run left RUNNING by a dead process is reconciled to FAILED by the next run, which proceeds', async () => {
      const ghost = randomUUID();
      await x(
        `INSERT INTO "Retention_Runs" ("id","trigger","startedAt","status") VALUES ($1::uuid,'SCHEDULED', now() - interval '45 minutes','RUNNING')`,
        ghost,
      );
      const r = await runAndWait();
      expect(r.run.status).toBe('OK');
      const g = (
        await q<Record<string, any>>(
          `SELECT "status","finishedAt","errorSummary" FROM "Retention_Runs" WHERE "id" = $1::uuid`,
          ghost,
        )
      )[0];
      expect(g.status).toBe('FAILED');
      expect(g.finishedAt).not.toBeNull();
      expect(g.errorSummary).toMatch(/INTERRUPTED/);
      await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, ghost);
    });

    it('the unique index makes a second RUNNING row impossible, whatever the lock does', async () => {
      const a = randomUUID();
      await x(
        `INSERT INTO "Retention_Runs" ("id","trigger","status") VALUES ($1::uuid,'MANUAL','RUNNING')`,
        a,
      );
      await expect(
        x(
          `INSERT INTO "Retention_Runs" ("id","trigger","status") VALUES (gen_random_uuid(),'MANUAL','RUNNING')`,
        ),
      ).rejects.toThrow();
      await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, a);
    });
  });

  // =================================================================================================
  describe('time: margin, clock jumps, budget (AC2, "Reloj")', () => {
    /**
     * The model of two clocks, injected into the running service: the database/application WALL clock (`offsetMs`
     * moves both, like a real jump or the passing of days) and the host's UPTIME counter + boot id. Rows are seeded
     * from the real database clock; the service sees `real + offsetMs`.
     */
    function twoClocks(init: { boot?: string; uptimeMs?: number } = {}) {
      const svc = t.svc as unknown as {
        monotonic: { anchor: () => { bootId: string; uptimeMs: number } };
        databaseNow: () => Promise<Date>;
      };
      const realDbNow = svc.databaseNow.bind(svc);
      const realMono = svc.monotonic;
      const realNow = Date.now.bind(Date);
      const nowSpy = vi.spyOn(Date, 'now');
      const st = {
        offsetMs: 0,
        boot: init.boot ?? 'e2e-boot',
        uptimeMs: init.uptimeMs ?? 1_800_000,
      };
      svc.monotonic = {
        anchor: () => ({ bootId: st.boot, uptimeMs: st.uptimeMs }),
      };
      svc.databaseNow = async () =>
        new Date((await realDbNow()).getTime() + st.offsetMs);
      /** Started directly (the admin token is a real-clock session and would be "expired" by the moved Date.now). */
      const run = async () => {
        nowSpy.mockImplementation(() => realNow() + st.offsetMs);
        try {
          const out = await t.svc.start('MANUAL', admin.id);
          if (out.kind !== 'started')
            throw new Error(`not started: ${out.kind}`);
          await out.done;
          return { runId: out.runId, ...(await waitRun(out.runId)) };
        } finally {
          nowSpy.mockImplementation(realNow);
        }
      };
      return {
        st,
        run,
        restore: async () => {
          nowSpy.mockRestore();
          svc.databaseNow = realDbNow;
          svc.monotonic = realMono;
          // a run with the clock moved days ahead also expires (and deletes) the admin session: take a fresh one
          admin = { ...admin, token: await mintAdminToken(t.app, admin.id) };
        },
      };
    }
    const effMs = (id: string) =>
      q<{ ms: string }>(
        `SELECT (extract(epoch FROM "effectiveNow") * 1000)::bigint::text AS ms FROM "Retention_Runs" WHERE "id" = $1::uuid`,
        id,
      ).then((r) => Number(r[0].ms));
    const realMs = async () =>
      Number(
        (
          await q<{ ms: string }>(
            `SELECT (extract(epoch FROM now()) * 1000)::bigint::text AS ms`,
          )
        )[0].ms,
      );
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    /** A previous run row `daysAgo` days old, written by ANOTHER boot (its uptime anchor is not this boot's). */
    async function insertPrevious(daysAgo: number, boot = 'e2e-old-boot') {
      const id = randomUUID();
      await x(
        `INSERT INTO "Retention_Runs" ("id","trigger","startedAt","finishedAt","status","tasks","effectiveNow","auditedAt","bootId","uptimeMs")
         VALUES ($1::uuid,'SCHEDULED', now() - make_interval(secs => $2::float8), now() - make_interval(secs => $2::float8), 'OK','[]',
                 now() - make_interval(secs => $2::float8), now() - make_interval(secs => $2::float8), $3, 999999999)`,
        id,
        daysAgo * 86_400,
        boot,
      );
      return id;
    }

    /** Daily runs after an outage of `outageDays` until the lag closes; reports how long it took. */
    async function catchUp(outageDays: number) {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const prev = await insertPrevious(outageDays);
      const prevEff = await effMs(prev);
      const clocks = twoClocks({ boot: 'e2e-new-boot', uptimeMs: 30 * 60_000 });
      try {
        const first = await clocks.run();
        const lags: number[] = [];
        const lagOf = async (runId: string) =>
          (await realMs()) + clocks.st.offsetMs - (await effMs(runId));
        lags.push(await lagOf(first.runId));
        let last = first;
        let days = 0;
        while (last.run.clockClamped === true && days < 40) {
          clocks.st.offsetMs += DAY;
          clocks.st.uptimeMs += DAY;
          last = await clocks.run();
          lags.push(await lagOf(last.runId));
          days++;
        }
        return {
          first,
          firstEff: await effMs(first.runId),
          prevEff,
          lags,
          days,
          last,
        };
      } finally {
        await clocks.restore();
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
        await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, prev);
      }
    }

    it('round-3 reproduction: previous run 6 days ago from another boot, logs of 6, 7.2, 8, 9 and 10.5 days: the usage log is purged by the database clock at once, the capped clock keeps the rest (clockClamped, fixed lag no more)', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const prev = await insertPrevious(6);
      const ids: Record<string, string> = {};
      for (const d of [6, 7.2, 8, 9, 10.5]) {
        ids[String(d)] = randomUUID();
        await x(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
           VALUES (now() - make_interval(secs => $2::float8), 'GET', $3, 200, 1, 'ANON', $1::uuid)`,
          ids[String(d)],
          d * 86_400,
          `/${MARK}-r3`,
        );
      }
      const s = await seed(`${MARK}-j`);
      // a contact message 12 months + 5 days old: past its period by the REAL clock, but not by the capped one
      const old = randomUUID();
      await x(
        `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
         VALUES ($1::uuid, $2, 'jump@212collectorsclub.test', 'x', ${ago('12 months 5 days')}, ${ago('12 months 5 days')})`,
        old,
        `${MARK}-j-contact-jump`,
      );
      const clocks = twoClocks({ boot: 'e2e-new-boot', uptimeMs: 1_800_000 });
      try {
        const r = await clocks.run();
        expect(r.run.clockClamped).toBe(true); // other boot: only the 30 min of uptime are credited, twice
        const eff = await effMs(r.runId);
        expect(eff - (await effMs(prev))).toBe(HOUR);
        // usage_logs cut by the database clock: everything past 7 days is gone on THIS run, the 6-day log stays
        for (const d of ['7.2', '8', '9', '10.5']) {
          expect(
            await rowCount('Usage_Logs', `"requestId" = '${ids[d]}'`),
          ).toBe(0);
        }
        expect(
          await rowCount('Usage_Logs', `"requestId" = '${ids['6']}'`),
        ).toBe(1);
        // every other task keeps the capped clock: not purged early
        expect(await rowCount('Contact_Inquiries', `"id" = '${old}'`)).toBe(1);
        expect(
          await rowCount('Contact_Inquiries', `"id" = '${s.contacts.old13m}'`),
        ).toBe(0); // 13 months: still gone
        // the audit event, the row and GET /admin/retention/runs say the clock was capped
        const ev = (
          await q<{ after: Record<string, any> }>(
            `SELECT "after" FROM "Audit_Events" WHERE "action" = 'RETENTION_PURGE_RUN' AND "entityId" = $1`,
            r.runId,
          )
        )[0];
        expect(ev.after.clockClamped).toBe(true);
        expect(r.run.bootId).toBe('e2e-new-boot');
        const listed = await get('/admin/retention/runs?limit=5').expect(200);
        const mine = (
          listed.body.items as { id: string; clockClamped: boolean }[]
        ).find((i) => i.id === r.runId);
        expect(mine?.clockClamped).toBe(true);
        // a second run seconds later (uptime +10 s): asOf moves 2x the real seconds, the lag does not freeze and does not jump
        clocks.st.uptimeMs += 10_000;
        const r2 = await clocks.run();
        expect((await effMs(r2.runId)) - eff).toBe(20_000);
        expect(await rowCount('Contact_Inquiries', `"id" = '${old}'`)).toBe(1);
      } finally {
        await clocks.restore();
        await x(`DELETE FROM "Contact_Inquiries" WHERE "id" = $1::uuid`, old);
        await x(`DELETE FROM "Usage_Logs" WHERE "route" = $1`, `/${MARK}-r3`);
        await cleanup(`${MARK}-j`, s);
        await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, prev);
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('outage of 5 days: the first run after the restart credits only the uptime; the lag shrinks a day per day and closes in about 5 days (not never)', async () => {
      const r = await catchUp(5);
      expect(r.firstEff - r.prevEff).toBe(HOUR);
      expect(r.first.run.clockClamped).toBe(true);
      expect(r.lags[0] / DAY).toBeGreaterThan(4.9);
      expect(r.lags[1]).toBeLessThan(r.lags[0] - 23 * HOUR);
      expect(r.days).toBeGreaterThanOrEqual(4);
      expect(r.days).toBeLessThanOrEqual(5);
      expect(r.last.run.clockClamped).toBe(false);
      process.stderr.write(
        `[time-to-catch-up] outage 5 d: ${r.days} daily runs; lag(h) per run: ${r.lags.map((l) => (l / HOUR).toFixed(1)).join(', ')}` +
          '\n',
      );
    });

    it('outage of 30 days: it closes in about 30 days (long, but visible and finite)', async () => {
      const r = await catchUp(30);
      expect(r.first.run.clockClamped).toBe(true);
      expect(r.days).toBeGreaterThanOrEqual(29);
      expect(r.days).toBeLessThanOrEqual(30);
      expect(r.last.run.clockClamped).toBe(false);
      process.stderr.write(
        `[time-to-catch-up] outage 30 d: ${r.days} daily runs; first lag ${(r.lags[0] / HOUR).toFixed(1)} h` +
          '\n',
      );
    }, 240_000);

    it('a previous effectiveNow in the FUTURE (the clock was wrong and has been set right) does not get the purge stuck', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const id = randomUUID();
      await x(
        `INSERT INTO "Retention_Runs" ("id","trigger","startedAt","finishedAt","status","tasks","effectiveNow","auditedAt","bootId","uptimeMs")
         VALUES ($1::uuid,'SCHEDULED', now() - interval '1 day', now() - interval '1 day','OK','[]', now() + interval '10 days', now() - interval '1 day', 'e2e-boot', 1000000)`,
        id,
      );
      const s = await seed(`${MARK}-f`);
      const clocks = twoClocks({ boot: 'e2e-boot', uptimeMs: 1_000_000 + DAY });
      try {
        const r = await clocks.run();
        expect(r.run.clockClamped).toBe(false);
        const eff = await effMs(r.runId);
        expect(Math.abs(eff - (await realMs()))).toBeLessThan(60_000); // adopted the database clock
        expect(
          await rowCount('Contact_Inquiries', `"id" = '${s.contacts.old13m}'`),
        ).toBe(0); // and the purge works
        clocks.st.uptimeMs += 5_000;
        const r2 = await clocks.run();
        expect(r2.run.clockClamped).toBe(false);
        expect((await effMs(r2.runId)) - eff).toBeGreaterThanOrEqual(0);
      } finally {
        await clocks.restore();
        await cleanup(`${MARK}-f`, s);
        await x(`DELETE FROM "Retention_Runs" WHERE "id" = $1::uuid`, id);
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('a clock set BACK 3 days: asOf follows it down (more cautious), and when it returns the lag closes at the pace of real time', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const clocks = twoClocks({ boot: 'e2e-boot', uptimeMs: 1_000_000 });
      try {
        const r0 = await clocks.run();
        const e0 = await effMs(r0.runId);
        clocks.st.offsetMs = -3 * DAY;
        clocks.st.uptimeMs += 60_000;
        const r1 = await clocks.run();
        expect(r1.run.clockClamped).toBe(false);
        expect(e0 - (await effMs(r1.runId))).toBeGreaterThan(2.9 * DAY);
        // the clock is right again one real hour later: the 3 days of lag come back at 2x real time, not at once
        clocks.st.offsetMs = 0;
        clocks.st.uptimeMs += HOUR;
        const e1 = await effMs(r1.runId);
        const r2 = await clocks.run();
        expect(r2.run.clockClamped).toBe(true);
        expect((await effMs(r2.runId)) - e1).toBe(2 * HOUR);
      } finally {
        await clocks.restore();
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('a container restart (new application on the same host boot, REAL anchors) keeps the measurement: with the clock +48 h, asOf advances 2x the uptime that passed', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const r0 = await runAndWait();
      expect(r0.run.bootId).toBeTruthy();
      const e0 = await effMs(r0.runId);
      const u0 = Number(r0.run.uptimeMs);
      await t.close();
      t = await boot(); // "docker restart": a new process, the same host boot
      const svc = t.svc as unknown as { databaseNow: () => Promise<Date> };
      const realDbNow = svc.databaseNow.bind(svc);
      const realNow = Date.now.bind(Date);
      const nowSpy = vi.spyOn(Date, 'now');
      svc.databaseNow = async () =>
        new Date((await realDbNow()).getTime() + 48 * HOUR);
      try {
        // the admin session of the NEW process was minted for the old one: take a fresh token
        admin = { ...admin, token: await mintAdminToken(t.app, admin.id) };
        nowSpy.mockImplementation(() => realNow() + 48 * HOUR);
        const out = await t.svc.start('MANUAL', admin.id);
        if (out.kind !== 'started') throw new Error('not started');
        await out.done;
        nowSpy.mockImplementation(realNow);
        const r1 = await waitRun(out.runId);
        expect(r1.run.bootId).toBe(r0.run.bootId);
        const u1 = Number(r1.run.uptimeMs);
        expect(u1).toBeGreaterThan(u0);
        expect(r1.run.clockClamped).toBe(true);
        expect((await effMs(out.runId)) - e0).toBe(2 * (u1 - u0));
      } finally {
        nowSpy.mockRestore();
        svc.databaseNow = realDbNow;
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('a REAL skew between the database and the application clocks is the one thing that stops the usage log too: nothing is purged', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const old = randomUUID();
      await x(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
         VALUES (now() - interval '9 days', 'GET', $2, 200, 1, 'ANON', $1::uuid)`,
        old,
        `/${MARK}-skew`,
      );
      const svc = t.svc as unknown as { databaseNow: () => Promise<Date> };
      const realDbNow = svc.databaseNow.bind(svc);
      svc.databaseNow = async () =>
        new Date((await realDbNow()).getTime() + HOUR);
      try {
        const r = await runAndWait();
        expect(r.run.status).toBe('FAILED');
        expect(String(r.run.errorSummary)).toMatch(/CLOCK_SKEW/);
        expect(await rowCount('Usage_Logs', `"requestId" = '${old}'`)).toBe(1);
      } finally {
        svc.databaseNow = realDbNow;
        await x(`DELETE FROM "Usage_Logs" WHERE "route" = $1`, `/${MARK}-skew`);
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('QA reproduction: a +48 h clock jump and three POSTs in a row move asOf by 2x the real seconds; the contact message is not purged early (the usage log IS, an accepted risk)', async () => {
      await x(`DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING'`);
      const JUMP_MS = 48 * 3_600_000;
      const svc = t.svc as unknown as {
        monotonic: { anchor: () => { bootId: string; uptimeMs: number } };
        databaseNow: () => Promise<Date>;
      };
      const realDbNow = svc.databaseNow.bind(svc);
      const realMono = svc.monotonic;
      let uptime = 1_000_000;
      let jumped = false;
      svc.monotonic = {
        anchor: () => ({ bootId: 'e2e-boot', uptimeMs: uptime }),
      };
      svc.databaseNow = async () => {
        const d = await realDbNow();
        return jumped ? new Date(d.getTime() + JUMP_MS) : d;
      };
      const realNow = Date.now.bind(Date);
      const nowSpy = vi.spyOn(Date, 'now');
      // rows that are WITHIN their period by the real clock but past it by the jumped one (the QA run deleted logs of
      // 5.1, 6.0 and 6.9 days): a contact message of 11 months 29 days (period 12 months) and three logs (period 7 days)
      const contact = randomUUID();
      await x(
        `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
         VALUES ($1::uuid, $2, 'qa@212collectorsclub.test', 'x', ${ago('11 months 29 days')}, ${ago('11 months 29 days')})`,
        contact,
        `${MARK}-q-contact`,
      );
      const logIds = [5.1, 6.0, 6.9].map(() => randomUUID());
      for (const [i, days] of [5.1, 6.0, 6.9].entries()) {
        await x(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
           VALUES (now() - make_interval(secs => $2::float8), 'GET', $3, 200, 1, 'ANON', $1::uuid)`,
          logIds[i],
          days * 86_400,
          `/${MARK}-q`,
        );
      }
      try {
        // run 0: the normal reference run (real clock) with an anchor
        const r0 = await runAndWait();
        expect(r0.run.clockClamped).toBe(false);
        // the clock jumps 48 h forward (database AND application), 10 s of real time pass
        jumped = true;
        uptime += 10_000;
        // started directly (the admin token is a real-clock session and would be "expired" by the jumped Date.now)
        const runJumped = async () => {
          nowSpy.mockImplementation(() => realNow() + JUMP_MS);
          try {
            const out = await t.svc.start('MANUAL', admin.id);
            if (out.kind !== 'started')
              throw new Error(`not started: ${out.kind}`);
            await out.done;
            return { runId: out.runId, ...(await waitRun(out.runId)) };
          } finally {
            nowSpy.mockImplementation(realNow);
          }
        };
        const runs = [];
        for (let i = 0; i < 3; i++) {
          runs.push(await runJumped());
          uptime += 5_000;
        }
        const eff = (id: string) =>
          q<{ ms: string }>(
            `SELECT (extract(epoch FROM "effectiveNow") * 1000)::bigint::text AS ms FROM "Retention_Runs" WHERE "id" = $1::uuid`,
            id,
          ).then((r) => Number(r[0].ms));
        const e0 = await eff(r0.runId);
        const e = [
          await eff(runs[0].runId),
          await eff(runs[1].runId),
          await eff(runs[2].runId),
        ];
        // 2x the 10 s, 5 s and 5 s of real time, NOT +48 h, +96 h, +144 h and not +3/+6/+9 days
        expect(e[0] - e0).toBe(20_000);
        expect(e[1] - e[0]).toBe(10_000);
        expect(e[2] - e[1]).toBe(10_000);
        for (const r of runs) {
          expect(r.run.status).toBe('OK');
          expect(r.run.clockClamped).toBe(true);
        }
        // the contact message within its period was not deleted: that task keeps the capped clock
        expect(await rowCount('Contact_Inquiries', `"id" = '${contact}'`)).toBe(
          1,
        );
        // ACCEPTED RISK (round 3, Angel: deleting the usage log on time comes first): the usage log is cut by the
        // database clock, which after a REAL jump of 48 h is 48 h ahead, so logs of 5.1, 6.0 and 6.9 days are
        // deleted early. Deleting a diagnostic log early is a far smaller harm than keeping IP/user agent past 7 days.
        for (const id of logIds) {
          expect(await rowCount('Usage_Logs', `"requestId" = '${id}'`)).toBe(0);
        }
        // the run list says so
        const listed = await get('/admin/retention/runs?limit=3').expect(200);
        expect(
          (listed.body.items as { clockClamped: boolean }[]).map(
            (i) => i.clockClamped,
          ),
        ).toEqual([true, true, true]);
        // the audit event of the last run says so too
        const ev = (
          await q<{ after: Record<string, any> }>(
            `SELECT "after" FROM "Audit_Events" WHERE "action" = 'RETENTION_PURGE_RUN' AND "entityId" = $1`,
            runs[2].runId,
          )
        )[0];
        expect(ev.after.clockClamped).toBe(true);
      } finally {
        nowSpy.mockRestore();
        svc.databaseNow = realDbNow;
        svc.monotonic = realMono;
        await x(
          `DELETE FROM "Contact_Inquiries" WHERE "id" = $1::uuid`,
          contact,
        );
        for (const id of logIds)
          await x(`DELETE FROM "Usage_Logs" WHERE "requestId" = $1::uuid`, id);
        await x(
          `DELETE FROM "Retention_Runs" WHERE "status" <> 'RUNNING' AND "triggeredById" = $1::uuid`,
          admin.id,
        );
      }
    });

    it('a run past its time budget stops between batches, marked truncated, and the next run takes the rest', async () => {
      const slow = await boot({
        RETENTION_BATCH_PAUSE_MS: '4000',
        RETENTION_MAX_RUN_MS: '10000',
      });
      const ids: string[] = [];
      for (let i = 0; i < 35; i++) {
        const id = randomUUID();
        ids.push(id);
        await x(
          `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
           VALUES ($1::uuid, $2, 'trunc@212collectorsclub.test', 'x', ${ago('14 months')}, ${ago('14 months')})`,
          id,
          `${MARK}-t-contact-${i}`,
        );
      }
      try {
        const out = await slow.svc.start('SCHEDULED');
        if (out.kind !== 'started') throw new Error(out.kind);
        const sum = await out.done;
        const contacts = sum.tasks.find((k) => k.name === 'contact_inquiries')!;
        expect(contacts.truncated).toBe(true);
        expect(contacts.rows).toBeGreaterThanOrEqual(20);
        expect(contacts.rows).toBeLessThan(35);
        const left = await rowCount(
          'Contact_Inquiries',
          `"name" LIKE '${MARK}-t-contact-%'`,
        );
        expect(left).toBe(35 - contacts.rows);
        // every other task still ran
        expect(sum.tasks.map((k) => k.name)).toEqual(slow.svc.taskNames());
      } finally {
        await slow.close();
      }
      const r = await runAndWait();
      expect(r.byTask.contact_inquiries.truncated).toBe(false);
      expect(
        await rowCount(
          'Contact_Inquiries',
          `"name" LIKE '${MARK}-t-contact-%'`,
        ),
      ).toBe(0);
    }, 90_000);
  });

  // =================================================================================================
  describe('failure isolation and the audit decision (AC6)', () => {
    it('a task that fails does not stop the others: PARTIAL, the error is a code, the rest is purged', async () => {
      const s = await seed(`${MARK}-f`);
      const admin2 = new pg.Client({ connectionString: urlOwner() });
      await admin2.connect();
      try {
        await admin2.query(
          `CREATE OR REPLACE FUNCTION zz_e2e_ret_fail() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'zz boom'; END $$`,
        );
        await admin2.query(
          `CREATE TRIGGER zz_e2e_ret_fail BEFORE DELETE ON "Contact_Inquiries" FOR EACH ROW EXECUTE FUNCTION zz_e2e_ret_fail()`,
        );
        const r = await runAndWait();
        expect(r.run.status).toBe('PARTIAL');
        expect(r.byTask.contact_inquiries.error).toMatch(
          /^[A-Za-z]+( [A-Za-z0-9]+)?$/,
        );
        expect(JSON.stringify(r.run.tasks)).not.toMatch(
          /zz boom|Contact_Inquiries/,
        );
        // the others went through
        expect(
          await rowCount(
            'Customer_Sessions',
            `"token" = '${s.sessions.expiredLong}'`,
          ),
        ).toBe(0);
        expect(await rowCount('Carts', `"id" = '${s.carts.expiredLong}'`)).toBe(
          0,
        );
        expect(
          await rowCount('Usage_Logs', `"requestId" = '${s.usage.old8d}'`),
        ).toBe(0);
        expect(r.byTask.usage_logs.error).toBeUndefined();
      } finally {
        await admin2.query(
          `DROP TRIGGER IF EXISTS zz_e2e_ret_fail ON "Contact_Inquiries"`,
        );
        await admin2.query(`DROP FUNCTION IF EXISTS zz_e2e_ret_fail()`);
        await admin2.end();
        await cleanup(`${MARK}-f`, s);
      }
    });

    it('AUDIT DOWN (decision): the expiry still happens, the run is PARTIAL with auditedAt NULL, and the NEXT run writes the missing event first', async () => {
      const s = await seed(`${MARK}-u`);
      try {
        const down = await blockAuditAction('RETENTION_PURGE_RUN', () =>
          runAndWait(),
        );
        expect(down.run.status).toBe('PARTIAL');
        expect(down.run.auditedAt).toBeNull();
        expect(down.run.errorSummary).toMatch(/AUDIT_NOT_WRITTEN/);
        // no effect was lost: the purge had already happened
        expect(
          await rowCount(
            'Customer_Sessions',
            `"token" = '${s.sessions.expiredLong}'`,
          ),
        ).toBe(0);
        expect(
          await rowCount('Usage_Logs', `"requestId" = '${s.usage.old8d}'`),
        ).toBe(0);
        expect(
          await rowCount(
            'Audit_Events',
            `"action" = 'RETENTION_PURGE_RUN' AND "entityId" = '${down.runId}'`,
          ),
        ).toBe(0);
        // the audit log is back: the next run first writes the late event for the previous one
        const next = await runAndWait();
        expect(next.run.status).toBe('OK');
        const late = await q<{ after: Record<string, any> }>(
          `SELECT "after" FROM "Audit_Events" WHERE "action" = 'RETENTION_PURGE_RUN' AND "entityId" = $1`,
          down.runId,
        );
        expect(late).toHaveLength(1);
        expect(late[0].after).toMatchObject({
          runId: down.runId,
          lateAudit: true,
        });
        expect(
          (
            await q<{ a: Date | null }>(
              `SELECT "auditedAt" AS a FROM "Retention_Runs" WHERE "id" = $1::uuid`,
              down.runId,
            )
          )[0].a,
        ).not.toBeNull();
        // and exactly once
        await runAndWait();
        expect(
          await rowCount(
            'Audit_Events',
            `"action" = 'RETENTION_PURGE_RUN' AND "entityId" = '${down.runId}'`,
          ),
        ).toBe(1);
      } finally {
        await cleanup(`${MARK}-u`, s);
      }
    });
  });

  // =================================================================================================
  describe('against live traffic: carts, merge and checkout (the lock order of 20.6a)', () => {
    it('a row somebody else holds is SKIPPED, never waited for: the run is not slowed or truncated, the row goes in the next run', async () => {
      const s = await seed(`${MARK}-l`);
      const holder = new pg.Client({ connectionString: urlOwner() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT 1 FROM "Carts" WHERE "id" = $1::uuid FOR UPDATE`,
          [s.carts.expiredLong],
        );
        await holder.query(
          `SELECT 1 FROM "Customer_Sessions" WHERE "token" = $1 FOR UPDATE`,
          [s.sessions.expiredLong],
        );
        const t0 = Date.now();
        const r = await runAndWait();
        const took = Date.now() - t0;
        expect(r.run.status).toBe('OK');
        expect(r.byTask.anon_carts.truncated).toBe(false);
        expect(r.byTask.anon_carts.error).toBeUndefined();
        // nobody waited for the 2 s lock budget of a batch
        expect(took).toBeLessThan(5_000);
        expect(await rowCount('Carts', `"id" = '${s.carts.expiredLong}'`)).toBe(
          1,
        );
        expect(
          await rowCount(
            'Customer_Sessions',
            `"token" = '${s.sessions.expiredLong}'`,
          ),
        ).toBe(1);
        // the rest of the run went through
        expect(
          await rowCount('Usage_Logs', `"requestId" = '${s.usage.old8d}'`),
        ).toBe(0);
        expect(
          await rowCount('Carts', `"id" = '${s.carts.expiredJustNow}'`),
        ).toBe(1);
        await holder.query('COMMIT');
        const r2 = await runAndWait();
        expect(r2.byTask.anon_carts.rows).toBeGreaterThanOrEqual(1);
        expect(await rowCount('Carts', `"id" = '${s.carts.expiredLong}'`)).toBe(
          0,
        );
        expect(
          await rowCount(
            'Customer_Sessions',
            `"token" = '${s.sessions.expiredLong}'`,
          ),
        ).toBe(0);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await cleanup(`${MARK}-l`, s);
      }
    });

    it('a cart claimed by an account while the purge runs is NOT deleted (its row is locked or no longer matches)', async () => {
      const s = await seed(`${MARK}-m`);
      const holder = new pg.Client({ connectionString: urlOwner() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        // what a merge does: claim the anonymous cart for the account (customerId set)
        await holder.query(
          `UPDATE "Carts" SET "customerId" = $2::uuid WHERE "id" = $1::uuid`,
          [s.carts.expiredLong, customerId],
        );
        const res = await post('/admin/retention/run').expect(202);
        await new Promise((r) => setTimeout(r, 600)); // the purge has gone past that row (skipped it)
        await holder.query('COMMIT');
        const r = await waitRun(res.body.runId as string);
        expect(r.byTask.anon_carts.error).toBeUndefined();
        const row = await q<{ customerId: string | null }>(
          `SELECT "customerId"::text FROM "Carts" WHERE "id" = $1::uuid`,
          s.carts.expiredLong,
        );
        expect(row).toEqual([{ customerId }]);
        expect(
          await rowCount('Cart_Items', `"cartId" = '${s.carts.expiredLong}'`),
        ).toBe(2);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await x(
          `DELETE FROM "Carts" WHERE "id" = $1::uuid`,
          s.carts.expiredLong,
        );
        await cleanup(`${MARK}-m`, s);
      }
    });

    it('guest carts and checkouts running while the job purges: every request answers, no cart in use is lost, no stock moves because of the purge', async () => {
      const s = await seed(`${MARK}-c`);
      // lots of expired rows so the run has real work (batch of 10: dozens of batches)
      for (let i = 0; i < 120; i++) {
        await x(
          `INSERT INTO "Carts" ("id","customerId","expiresAt","createdAt","updatedAt") VALUES (gen_random_uuid(), NULL, ${ago('40 days')}, ${ago('60 days')}, ${ago('60 days')})`,
        );
      }
      const stockBefore = await fingerprint('Products');
      const createdOrders: string[] = [];
      try {
        // N guests fill a cart each
        const cookies: string[] = [];
        for (let i = 0; i < 6; i++) {
          const add = await t
            .server()
            .post(`${BASE}/cart/items`)
            .send({ productId: OP_ROMANCE_DAWN_ID, quantity: 1 })
            .expect(201);
          const raw = (add.headers['set-cookie'] as unknown as string[]).find(
            (c) => c.startsWith('cartId='),
          )!;
          cookies.push(raw.split(';')[0]);
        }
        const run = post('/admin/retention/run');
        const traffic = cookies.map((ck, i) =>
          i % 2 === 0
            ? t
                .server()
                .post(`${BASE}/cart/items`)
                .set('Cookie', ck)
                .send({ productId: MTG_TIN_ID, quantity: 1 })
            : t
                .server()
                .post(`${BASE}/checkout`)
                .set('Cookie', ck)
                .send(
                  withBuyerId({
                    paymentRail: 'pago_movil',
                    fulfillmentType: 'delivery',
                    addressLine1: 'Av. Test 1',
                    city: 'Caracas',
                    state: 'Distrito Capital',
                    recipientName: 'Maria Perez',
                    recipientPhone: '0412-1234567',
                  }),
                ),
        );
        const results = await Promise.all([run, ...traffic]);
        expect(results[0].status).toBe(202);
        for (const r of results.slice(1)) {
          expect([200, 201]).toContain(r.status);
          if (r.body?.orderId) createdOrders.push(r.body.orderId as string);
        }
        await waitRun(results[0].body.runId as string);
        // every cart of a request that did not check out is still there (valid carts are never candidates)
        for (let i = 0; i < cookies.length; i += 2) {
          const cid = cookies[i]
            .split('=')[1]
            .split('.')[0]
            .replace(/^s%3A/, '');
          expect(
            await rowCount('Carts', `"id" = '${decodeURIComponent(cid)}'`),
          ).toBe(1);
        }
        // the 120 expired carts are gone
        expect(
          await rowCount(
            'Carts',
            `"customerId" IS NULL AND "expiresAt" < ${ago('1 day')}`,
          ),
        ).toBe(0);
      } finally {
        for (const id of createdOrders) {
          const holds = await q<{ productId: string; quantity: number }>(
            `SELECT "productId"::text, "quantity" FROM "Stock_Holds" WHERE "orderId" = $1::uuid`,
            id,
          );
          for (const h of holds)
            await x(
              `UPDATE "Products" SET "heldQty" = "heldQty" - $2 WHERE "id" = $1::uuid`,
              h.productId,
              h.quantity,
            );
          await t.prisma.order.delete({ where: { id } }).catch(() => undefined);
        }
        await x(
          `DELETE FROM "Carts" WHERE "customerId" IS NULL AND "createdAt" > ${ago('2 minutes')} AND "expiresAt" > now()`,
        );
        await cleanup(`${MARK}-c`, s);
        // the stock columns are exactly what they were (checkouts restored by hand above)
        const stockAfter = await fingerprint('Products');
        expect(stockAfter.n).toBe(stockBefore.n);
      }
    });
  });
});

/** Connection string of the application role as the test run configured it. */
function urlForLock(): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.searchParams.delete('schema');
  return u.toString();
}
/** The owner/migrator (DDL, and a connection the app role's locks can be tested against). */
function urlOwner(): string {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  return u.toString();
}
