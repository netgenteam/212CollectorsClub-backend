import { isDeepStrictEqual } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import request from 'supertest';
import * as argon2 from 'argon2';
import { vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { VitrinaScoringService } from './../src/vitrina/vitrina-scoring.service.js';
import { VitrinaDataLoader } from './../src/vitrina/vitrina-data.loader.js';
import { VitrinaCronService } from './../src/vitrina/vitrina-cron.service.js';
import {
  restoreDailyStats,
  snapshotDailyStats,
  type DailyStatRows,
} from './helpers/db-snapshot.js';
import {
  restoreVitrina,
  snapshotVitrina,
  type VitrinaSnapshot,
} from './helpers/vitrina-snapshot.js';

type App = Parameters<typeof request>[0];
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-vitrina-18-8-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PASS = 'correct-horse-battery-staple-18-8';
const BASE = '/api/v1/admin/vitrina';
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('vitrina:recompute', 0))`;

interface Run {
  runId: string;
  computedAt: string;
  mode: string;
  salesCount: number;
}
interface ScoreRow {
  productId: string;
  rank: number;
  score: string;
  reason: string | null;
  components: Record<string, { points?: number }> & { scarcityFactor: number };
}
interface PreviewItem {
  productId: string;
  source: string;
  rank: number | null;
  score: number | null;
  reason: string | null;
  components:
    | (Record<string, { points: number }> & {
        scarcityFactor: number;
      })
    | null;
}
interface Preview {
  computedAt: string | null;
  runMode: string | null;
  items: PreviewItem[];
}
interface Algo {
  wSales: number;
  wRevenue: number;
  wVelocity: number;
  wInterest: number;
  wNovelty: number;
  halfLifeDays: number;
  windowDays: number;
  noveltyDays: number;
  maxPerFranchise: number;
  mmrLambda: number;
  priorM: number;
  currentRunId: string | null;
  lastRun: Run | null;
  recompute?: { status: string; run: Run | null };
}
const DEFAULTS = {
  wSales: 40,
  wRevenue: 15,
  wVelocity: 15,
  wInterest: 20,
  wNovelty: 10,
  halfLifeDays: 14,
  windowDays: 90,
  noveltyDays: 21,
  maxPerFranchise: 4,
  mmrLambda: 0.35,
  priorM: 3,
};

/**
 * Story 18.8 (AD-81, AD-84): scoring service, atomic runs, locks, cron
 * guard and admin API against the real Postgres. All fixtures are tagged;
 * the four Vitrina tables and Product_Daily_Stats are snapshotted/restored.
 */
describe('Vitrina scoring service + admin (e2e, Story 18.8)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let scoring: VitrinaScoringService;
  let cron: VitrinaCronService;
  let token: string;
  let adminId: string;
  let categoryId: string;
  let saved: VitrinaSnapshot;
  let savedStats: DailyStatRows;
  let swagger: { paths: Record<string, Record<string, unknown>> };
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const id: Record<string, string> = {};
  const envBackup = { ...process.env };

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const sql = async (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const currentRunId = async () =>
    (
      await sql(
        `SELECT "currentRunId" FROM "Vitrina_Algorithm_Settings" WHERE id='default'`,
      )
    )[0].currentRunId as string | null;
  const runIds = async () =>
    (await sql(`SELECT id FROM "Product_Score_Runs"`)).map(
      (r) => r.id as string,
    );
  const scoresOf = async (runId: string) =>
    (await sql(
      `SELECT "productId", rank, score::text, reason, components FROM "Product_Scores"
       WHERE "runId" = $1::uuid ORDER BY rank`,
      [runId],
    )) as unknown as ScoreRow[];
  const recomputeHttp = () => server().post(`${BASE}/recompute`).set(auth());
  const putAlgo = (body: object) =>
    server().put(`${BASE}/algorithm`).set(auth()).send(body);
  const resetAlgo = () => putAlgo(DEFAULTS).expect(200);

  const mkProduct = async (
    key: string,
    o: {
      franchise?: string;
      stock?: number;
      createdAt?: Date;
      productType?: string;
      category?: string;
    } = {},
  ) => {
    const p = await prisma.product.create({
      data: {
        name: `Vit${TAG} ${key}`,
        slug: `vit${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 18.8.',
        franchise: (o.franchise ?? 'DRAGON_BALL_SUPER') as 'NARUTO',
        productType: (o.productType ?? 'BOOSTER_BOX') as 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '10.00',
        stock: o.stock ?? 50,
        heldQty: 0,
        categoryId: o.category ?? categoryId,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    productIds.push(p.id);
    id[key] = p.id;
    return p.id;
  };
  const mkOrder = async (
    status: 'PAID' | 'FULFILLED' | 'EXPIRED',
    lines: { productId: string; qty: number; at: Date }[],
  ) => {
    const o = await prisma.order.create({
      data: {
        status,
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'PICKUP',
        recipientName: 'Vit Tester',
        recipientPhone: '04120000000',
        totalUsd: '10.00',
        accessTokenHash: createHash('sha256')
          .update(randomBytes(16))
          .digest('hex'),
        lines: {
          create: lines.map((l) => ({
            productId: l.productId,
            productName: 'x',
            unitPriceUsd: '10.00',
            quantity: l.qty,
            lineTotalUsd: (l.qty * 10).toFixed(2),
            createdAt: l.at,
          })),
        },
      },
    });
    orderIds.push(o.id);
    return o.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    ) as unknown as typeof swagger;
    await app.init();
    prisma = app.get(PrismaService);
    scoring = app.get(VitrinaScoringService);
    cron = app.get(VitrinaCronService);
    saved = await snapshotVitrina(sql);
    savedStats = await snapshotDailyStats(prisma);
    categoryId = (await prisma.category.findFirstOrThrow()).id;

    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: EMAIL,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    // --- AC7 fixture (own ids) -------------------------------------------
    await mkProduct('A', { createdAt: daysAgo(100) }); // 30 units, 60 d ago
    await mkProduct('B', { createdAt: daysAgo(100) }); // 8 units in 5 d
    await mkProduct('C', { createdAt: new Date() }); // new, 2 units
    await mkProduct('SOLD', { stock: 0, createdAt: daysAgo(100) });
    const cat = await prisma.category.create({
      data: { name: `Vit ${TAG} franchise`, slug: `vit-${TAG}-fr` },
    });
    for (let i = 0; i < 10; i++)
      await mkProduct(`F${i}`, {
        franchise: 'OTHER',
        category: cat.id,
        createdAt: daysAgo(100),
      });
    await mkOrder('PAID', [{ productId: id.A, qty: 30, at: daysAgo(60) }]);
    await mkOrder('PAID', [{ productId: id.B, qty: 4, at: daysAgo(5) }]);
    await mkOrder('FULFILLED', [{ productId: id.B, qty: 4, at: daysAgo(2) }]);
    await mkOrder('PAID', [{ productId: id.C, qty: 2, at: new Date() }]);
    await mkOrder('PAID', [{ productId: id.SOLD, qty: 20, at: daysAgo(1) }]);
    // Not PAID/FULFILLED: must never count (would make A beat B).
    await mkOrder('EXPIRED', [{ productId: id.A, qty: 50, at: daysAgo(1) }]);
    for (let i = 0; i < 10; i++)
      await mkOrder('PAID', [
        { productId: id[`F${i}`], qty: 1 + (i % 3), at: daysAgo(3) },
      ]);
    await resetAlgo();
  });

  afterAll(async () => {
    process.env = envBackup;
    vi.restoreAllMocks();
    // Order: scores/stats -> orders -> products (then the restore).
    await prisma.productScore.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.productDailyStat.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({ where: { slug: `vit-${TAG}-fr` } });
    await restoreDailyStats(prisma, savedStats);
    await restoreVitrina(sql, saved);
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    expect(JSON.stringify(await snapshotVitrina(sql))).toBe(
      JSON.stringify(saved),
    );
    await app.close();
  });

  describe('AC1/AC7: ranking from real orders', () => {
    it('B above A, C present, sold-out absent, <= 4 per franchise, EXPIRED not counted', async () => {
      const res = await recomputeHttp().expect(200);
      const run = res.body as Run;
      expect(run.mode).toBe('RANKED');
      expect(run.salesCount).toBeGreaterThanOrEqual(30 + 8 + 2);
      expect(await currentRunId()).toBe(run.runId);
      const rows = await scoresOf(run.runId);
      const rank = (k: string) => rows.find((r) => r.productId === id[k])?.rank;
      expect(rank('B')).toBeDefined();
      expect(rank('A')).toBeDefined();
      expect(rank('B')!).toBeLessThan(rank('A')!);
      expect(rank('C')).toBeDefined();
      expect(rank('SOLD')).toBeUndefined();
      const same = Object.keys(id)
        .filter((k) => /^F\d/.test(k))
        .map((k) => id[k]);
      const inRun = rows.filter((r) => same.includes(r.productId)).length;
      expect(inRun).toBe(4);
      expect(rows.length).toBeLessThanOrEqual(48);
      expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
    });

    it('same input => same ranking in two runs (fixed now)', async () => {
      const now = new Date();
      const a = await scoring.recompute('ADMIN', now);
      const b = await scoring.recompute('ADMIN', now);
      if (a.status !== 'OK' || b.status !== 'OK') throw new Error('busy');
      const norm = async (runId: string) =>
        (await scoresOf(runId)).map((r) => [r.productId, r.rank, r.score]);
      expect(await norm(b.runId)).toEqual(await norm(a.runId));
      expect(a.runId).not.toBe(b.runId);
    });
  });

  describe('AC2: atomic persistence', () => {
    it('failure mid-transaction => rollback, previous ranking stays current', async () => {
      await recomputeHttp().expect(200);
      const cur = await currentRunId();
      const runsBefore = (await runIds()).sort();
      const scoreCount = (
        await sql(`SELECT count(*)::int n FROM "Product_Scores"`)
      )[0].n;
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const spy = vi
        .spyOn(
          scoring as unknown as { beforePointerSwap: () => Promise<void> },
          'beforePointerSwap',
        )
        .mockRejectedValueOnce(new Error('boom'));
      const res = await recomputeHttp();
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await currentRunId()).toBe(cur);
      expect((await runIds()).sort()).toEqual(runsBefore);
      expect(
        (await sql(`SELECT count(*)::int n FROM "Product_Scores"`))[0].n,
      ).toBe(scoreCount);
      // The lock was released with the rollback: next run works.
      await recomputeHttp().expect(200);
      vi.restoreAllMocks();
    });

    it('keeps only the 3 latest runs (scores cascade)', async () => {
      for (let i = 0; i < 4; i++) await recomputeHttp().expect(200);
      const ids = await runIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain(await currentRunId());
      const orphans = await sql(
        `SELECT count(*)::int n FROM "Product_Scores" s
         WHERE NOT EXISTS (SELECT 1 FROM "Product_Score_Runs" r WHERE r.id = s."runId")`,
      );
      expect(orphans[0].n).toBe(0);
      // Run copies the config used.
      const r = await sql(
        `SELECT config, "durationMs" FROM "Product_Score_Runs" WHERE id = $1::uuid`,
        [(await currentRunId())!],
      );
      expect(r[0].config).toMatchObject({ wSales: 40, windowDays: 90 });
      expect(typeof r[0].durationMs).toBe('number');
    });

    it('pruneRuns is idempotent and never removes the current run', async () => {
      await scoring.pruneRuns();
      await scoring.pruneRuns();
      expect(await runIds()).toContain(await currentRunId());
    });
  });

  describe('AC3/AC4: lock, cron guard, bootstrap', () => {
    it('Promise.all of 5 POST /recompute => exactly 1 run, the rest 409, no 5xx', async () => {
      const before = new Set(await runIds());
      // Hold the lock a while so the race is real, not a lucky sequence.
      vi.spyOn(
        scoring as unknown as { beforePointerSwap: () => Promise<void> },
        'beforePointerSwap',
      ).mockImplementation(async () => {
        await sleep(600);
      });
      const res = await Promise.all(
        Array.from({ length: 5 }, () => recomputeHttp()),
      );
      vi.restoreAllMocks();
      const statuses = res.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409]);
      for (const r of res.filter((x) => x.status === 409))
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'RECOMPUTE_IN_PROGRESS',
        );
      const created = (await runIds()).filter((r) => !before.has(r));
      expect(created).toHaveLength(1);
      expect(created[0]).toBe(await currentRunId());
    });

    it('another session holding the lock => POST 409 and the cron exits silently', async () => {
      const holder = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(LOCK_SQL);
        const before = (await runIds()).sort();
        await recomputeHttp().expect(409);
        process.env.VITRINA_CRON_ENABLED = 'true';
        expect(await cron.run('CRON')).toBe('SKIPPED');
        await cron.handleCron(); // must not throw
        expect((await runIds()).sort()).toEqual(before);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await cron.run('CRON')).toBe('COMPUTED');
    });

    it('cron/bootstrap flag: disabled under test by default, "false" off, bootstrap only without a current run', async () => {
      delete process.env.VITRINA_CRON_ENABLED;
      expect(cron.isEnabled()).toBe(false); // NODE_ENV=test
      expect(await cron.bootstrapCompute()).toBe('SKIPPED');
      process.env.VITRINA_CRON_ENABLED = 'false';
      expect(cron.isEnabled()).toBe(false);
      process.env.VITRINA_CRON_ENABLED = 'true';
      expect(cron.isEnabled()).toBe(true);
      expect(await cron.bootstrapCompute()).toBe('SKIPPED'); // has a run
      await sql(
        `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = NULL WHERE id='default'`,
      );
      expect(await cron.bootstrapCompute()).toBe('COMPUTED');
      expect(await currentRunId()).not.toBeNull();
      delete process.env.VITRINA_CRON_ENABLED;
    });

    it('handlePurgeCron prunes old runs when enabled', async () => {
      process.env.VITRINA_CRON_ENABLED = 'true';
      await sql(
        `INSERT INTO "Product_Score_Runs" ("id","computedAt","mode","config","salesCount","durationMs")
         SELECT gen_random_uuid(), now() - (g || ' days')::interval - interval '1 year', 'FALLBACK', '{}'::jsonb, 0, 1
         FROM generate_series(1, 3) g`,
      );
      expect((await runIds()).length).toBeGreaterThan(3);
      await cron.handlePurgeCron();
      const ids = await runIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain(await currentRunId());
      delete process.env.VITRINA_CRON_ENABLED;
    });
  });

  describe('AC5: GET/PUT /admin/vitrina/algorithm', () => {
    it('401 without a token on every route', async () => {
      await server().get(`${BASE}/algorithm`).expect(401);
      await server().put(`${BASE}/algorithm`).send(DEFAULTS).expect(401);
      await server().post(`${BASE}/recompute`).expect(401);
      await server().get(`${BASE}/preview`).expect(401);
    });

    it('GET returns defaults, constants and the last run', async () => {
      const a = (
        await server().get(`${BASE}/algorithm`).set(auth()).expect(200)
      ).body as Algo & { scarcityThreshold: number };
      expect(a).toMatchObject({ ...DEFAULTS, scarcityThreshold: 3 });
      expect(a.currentRunId).toBe(await currentRunId());
      expect(a.lastRun?.runId).toBe(a.currentRunId);
    });

    it('weights not adding up to 100 => 400 VITRINA_WEIGHTS_INVALID', async () => {
      const res = await putAlgo({ ...DEFAULTS, wSales: 41 }).expect(400);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'VITRINA_WEIGHTS_INVALID',
      );
      await putAlgo({ ...DEFAULTS, wSales: 0, wRevenue: 0 }).expect(400);
    });

    it.each([
      [
        'weight > 100',
        { wSales: 101, wRevenue: 0, wVelocity: 0, wInterest: 0, wNovelty: -1 },
      ],
      ['negative weight', { wSales: 110, wRevenue: -10 }],
      ['non-integer weight', { wSales: 40.5, wRevenue: 14.5 }],
      ['halfLifeDays 0', { halfLifeDays: 0 }],
      ['halfLifeDays 91', { halfLifeDays: 91 }],
      ['windowDays 13', { windowDays: 13 }],
      ['windowDays 366', { windowDays: 366 }],
      ['noveltyDays 0', { noveltyDays: 0 }],
      ['noveltyDays 91', { noveltyDays: 91 }],
      ['maxPerFranchise 0', { maxPerFranchise: 0 }],
      ['maxPerFranchise 13', { maxPerFranchise: 13 }],
      ['mmrLambda 1.01', { mmrLambda: 1.01 }],
      ['mmrLambda -0.1', { mmrLambda: -0.1 }],
      ['mmrLambda 3 decimals', { mmrLambda: 0.123 }],
      ['priorM 50.5', { priorM: 50.5 }],
      ['priorM -1', { priorM: -1 }],
      ['unknown field', { extra: 1 }],
      ['recompute not boolean', { recompute: 'yes' }],
    ])('validation: %s => 400', async (_n, patch) => {
      await putAlgo({ ...DEFAULTS, ...patch }).expect(400);
    });

    it('windowDays < halfLifeDays (merged with stored value) => 400 VITRINA_PARAMS_INVALID', async () => {
      const res = await putAlgo({
        ...DEFAULTS,
        halfLifeDays: 60,
        windowDays: 30,
      }).expect(400);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'VITRINA_PARAMS_INVALID',
      );
      await putAlgo({ ...DEFAULTS, halfLifeDays: 90, windowDays: 14 }).expect(
        400,
      );
      // Failed PUTs leave no audit and no change.
      const a = (await server().get(`${BASE}/algorithm`).set(auth()))
        .body as Algo;
      expect(a).toMatchObject(DEFAULTS);
    });

    it('valid PUT: updates, audits before/after + adminUserId, does NOT recompute', async () => {
      const cur = await currentRunId();
      const runs = (await runIds()).sort();
      const auditsBefore = await prisma.vitrinaAlgorithmAudit.count();
      const body = {
        ...DEFAULTS,
        wSales: 30,
        wRevenue: 25,
        mmrLambda: 0.5,
        priorM: 7.25,
        maxPerFranchise: 3,
      };
      const res = (await putAlgo(body).expect(200)).body as Algo;
      expect(res).toMatchObject({
        wSales: 30,
        wRevenue: 25,
        mmrLambda: 0.5,
        priorM: 7.25,
      });
      expect(res.recompute?.status).toBe('NOT_REQUESTED');
      expect(await currentRunId()).toBe(cur);
      expect((await runIds()).sort()).toEqual(runs);
      const audits = await prisma.vitrinaAlgorithmAudit.findMany({
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(await prisma.vitrinaAlgorithmAudit.count()).toBe(auditsBefore + 1);
      expect(audits[0].adminUserId).toBe(adminId);
      expect(audits[0].before).toMatchObject({
        wSales: 40,
        maxPerFranchise: 4,
      });
      expect(audits[0].after).toMatchObject({
        wSales: 30,
        mmrLambda: 0.5,
        priorM: 7.25,
        maxPerFranchise: 3,
      });
      await resetAlgo();
    });

    it('GET /algorithm/audit: paginated, newest first, admin {id,email}, 400 out of range', async () => {
      const total = await prisma.vitrinaAlgorithmAudit.count();
      await putAlgo({ ...DEFAULTS, wSales: 31, wRevenue: 24 }).expect(200);
      await putAlgo({ ...DEFAULTS, wSales: 32, wRevenue: 23 }).expect(200);
      const get = (qs: string) => server().get(`${BASE}/algorithm/audit${qs}`);
      await get('').expect(401);
      const res = await get('?page=1&limit=2').set(auth()).expect(200);
      const body = res.body as {
        data: {
          id: string;
          createdAt: string;
          admin: { id: string; email: string } | null;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        }[];
        meta: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      };
      expect(body.meta).toMatchObject({
        page: 1,
        limit: 2,
        total: total + 2,
        totalPages: Math.ceil((total + 2) / 2),
      });
      expect(body.data).toHaveLength(2);
      expect(body.data[0].admin).toEqual({ id: adminId, email: EMAIL });
      expect(body.data[0].after).toMatchObject({ wSales: 32, wRevenue: 23 });
      expect(body.data[0].before).toMatchObject({ wSales: 31 });
      expect(body.data[1].after).toMatchObject({ wSales: 31 });
      expect(body.data[0].createdAt >= body.data[1].createdAt).toBe(true);
      await get('?limit=101').set(auth()).expect(400);
      await get('?limit=0').set(auth()).expect(400);
      await get('?page=0').set(auth()).expect(400);
      await get('?page=abc').set(auth()).expect(400);
      await resetAlgo();
    });

    it('GET /algorithm does not block while the settings row is locked', async () => {
      const holder = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT 1 FROM "Vitrina_Algorithm_Settings" WHERE id='default' FOR UPDATE`,
        );
        const t0 = Date.now();
        await server().get(`${BASE}/algorithm`).set(auth()).expect(200);
        expect(Date.now() - t0).toBeLessThan(2_000);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });

    it('loader: daily sales `at` is the quantity-weighted mean time of the day', async () => {
      await mkProduct('W', { createdAt: daysAgo(100) });
      const day = new Date(
        daysAgo(20).toISOString().slice(0, 10) + 'T00:00:00.000Z',
      );
      const at = (h: number) => new Date(day.getTime() + h * 3_600_000);
      await mkOrder('PAID', [{ productId: id.W, qty: 1, at: at(0) }]);
      await mkOrder('PAID', [{ productId: id.W, qty: 3, at: at(8) }]);
      const loader = app.get(VitrinaDataLoader);
      const data = await prisma.$transaction((tx) =>
        loader.load(tx, 90, new Date()),
      );
      const sales = data.events.sales.filter((e) => e.productId === id.W);
      expect(sales).toHaveLength(1);
      expect(sales[0].qty).toBe(4);
      // (0*1 + 8*3) / 4 = 6h (MAX would have said 8h).
      expect(sales[0].at.getTime()).toBe(at(6).getTime());
    });

    it('PUT with recompute:true recomputes after saving', async () => {
      const cur = await currentRunId();
      const res = (
        await putAlgo({
          ...DEFAULTS,
          wSales: 35,
          wRevenue: 20,
          recompute: true,
        }).expect(200)
      ).body as Algo;
      expect(res.recompute?.status).toBe('DONE');
      expect(res.currentRunId).not.toBe(cur);
      expect(res.lastRun?.runId).toBe(res.recompute?.run?.runId);
      const run = await sql(
        `SELECT config FROM "Product_Score_Runs" WHERE id=$1::uuid`,
        [res.currentRunId],
      );
      expect(run[0].config).toMatchObject({ wSales: 35, wRevenue: 20 });
      await resetAlgo();
    });

    it('5 concurrent PUTs => 5 chained audits, no 5xx', async () => {
      await resetAlgo();
      const start = (await server().get(`${BASE}/algorithm`).set(auth()))
        .body as Algo;
      const startCfg = Object.fromEntries(
        [
          ...Object.keys(DEFAULTS),
          'scarcityThreshold',
          'minSalesForRanking',
          'viewDayCap',
        ].map((k) => [k, (start as unknown as Record<string, unknown>)[k]]),
      );
      const before = new Set(
        (await prisma.vitrinaAlgorithmAudit.findMany()).map((a) => a.id),
      );
      const bodies = [0, 1, 2, 3, 4].map((i) => ({
        ...DEFAULTS,
        wSales: 40 - i,
        wRevenue: 15 + i,
        halfLifeDays: 10 + i,
      }));
      const res = await Promise.all(bodies.map((b) => putAlgo(b)));
      expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const audits = (await prisma.vitrinaAlgorithmAudit.findMany()).filter(
        (a) => !before.has(a.id),
      );
      expect(audits).toHaveLength(5);
      expect(audits.every((a) => a.adminUserId === adminId)).toBe(true);
      // Follow the chain from the pre-burst state: each `before` is the previous `after`.
      const left = [...audits];
      let cur: unknown = startCfg;
      for (let i = 0; i < 5; i++) {
        const idx = left.findIndex((a) => isDeepStrictEqual(a.before, cur));
        expect(idx).toBeGreaterThanOrEqual(0);
        cur = left.splice(idx, 1)[0].after;
      }
      const final = (await server().get(`${BASE}/algorithm`).set(auth()))
        .body as Algo;
      expect(final).toMatchObject(cur as object);
      await resetAlgo();
    });
  });

  describe('AC6: GET /admin/vitrina/preview', () => {
    beforeAll(async () => {
      await recomputeHttp().expect(200);
    });
    const preview = (qs = '') =>
      server().get(`${BASE}/preview${qs}`).set(auth());

    it.each([
      ['mode=BAD'],
      ['size=3'],
      ['size=13'],
      ['size=abc'],
      ['pinned=not-a-uuid'],
      [`pinned=${Array.from({ length: 13 }, () => randomUUID()).join(',')}`],
    ])('invalid %s => 400', async (qs) => {
      await preview(`?${qs}`).expect(400);
    });

    it('AUTO: size items with reason/rank/score and components that add up to the score', async () => {
      const res = (await preview('?mode=AUTO&size=8').expect(200))
        .body as Preview;
      expect(res.items.length).toBeGreaterThan(0);
      expect(res.items.length).toBeLessThanOrEqual(8);
      expect(res.runMode).toBe('RANKED');
      expect(new Date(res.computedAt as string).getTime()).toBeGreaterThan(0);
      expect(res.items.every((i) => i.source === 'auto')).toBe(true);
      expect(res.items.map((i) => i.rank)).toEqual(
        [...res.items.map((i) => i.rank as number)].sort((a, b) => a - b),
      );
      for (const i of res.items) {
        const c = i.components!;
        const sum = ['sales', 'revenue', 'velocity', 'interest', 'novelty']
          .map((k) => c[k].points)
          .reduce((x, y) => x + y, 0);
        expect(
          Math.abs(sum * c.scarcityFactor - (i.score as number)),
        ).toBeLessThan(1e-3);
        expect(i).toHaveProperty('reason');
      }
    });

    it('MIXED: pinned first in order, no duplicates, sold-out and unknown pinned dropped; MANUAL: only pinned', async () => {
      const unknown = randomUUID();
      const pinned = [id.C, unknown, id.SOLD, id.B].join(',');
      const res = (
        await preview(`?mode=MIXED&size=6&pinned=${pinned}`).expect(200)
      ).body as Preview;
      expect(res.items.length).toBeLessThanOrEqual(6);
      expect(res.items[0]).toMatchObject({ productId: id.C, source: 'pinned' });
      expect(res.items[1]).toMatchObject({ productId: id.B, source: 'pinned' });
      const ids = res.items.map((i) => i.productId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(id.SOLD);
      expect(ids).not.toContain(unknown);
      expect(res.items.slice(2).every((i) => i.source === 'auto')).toBe(true);
      const manual = (
        await preview(`?mode=MANUAL&size=8&pinned=${id.B},${id.A}`).expect(200)
      ).body as Preview;
      expect(manual.items.map((i) => i.productId)).toEqual([id.B, id.A]);
      const auto = (await preview(`?mode=AUTO&pinned=${id.B}`).expect(200))
        .body as Preview;
      expect(auto.items.every((i) => i.source === 'auto')).toBe(true);
    });

    it('no current run => empty auto selection, null computedAt', async () => {
      const cur = await currentRunId();
      await sql(
        `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = NULL WHERE id='default'`,
      );
      try {
        const res = (await preview('?mode=AUTO').expect(200)).body as Preview;
        expect(res).toMatchObject({
          items: [],
          computedAt: null,
          runMode: null,
        });
      } finally {
        await sql(
          `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = $1::uuid WHERE id='default'`,
          [cur],
        );
      }
    });
  });

  describe('AC7: FALLBACK', () => {
    it('0 sales in the window => FALLBACK with a non-empty ranking', async () => {
      await sql(
        `UPDATE "Order_Lines" SET "createdAt" = now() - interval '200 days'
         WHERE "productId" = ANY($1::uuid[])`,
        [productIds],
      );
      // A 14-day window also leaves real (older) sales of the dev DB out.
      await putAlgo({ ...DEFAULTS, halfLifeDays: 7, windowDays: 14 }).expect(
        200,
      );
      const run = (await recomputeHttp().expect(200)).body as Run;
      await resetAlgo();
      expect(run).toMatchObject({ mode: 'FALLBACK' });
      expect(run.salesCount).toBeLessThan(5);
      expect((await scoresOf(run.runId)).length).toBeGreaterThan(0);
    });
  });

  describe('Swagger (DoD)', () => {
    it('documents the 4 endpoints with their errorCodes', () => {
      const p = swagger.paths;
      const text = (path: string, m: string) => JSON.stringify(p[path]?.[m]);
      expect(text('/api/v1/admin/vitrina/algorithm', 'put')).toContain(
        'VITRINA_WEIGHTS_INVALID',
      );
      expect(text('/api/v1/admin/vitrina/algorithm', 'put')).toContain(
        'requestBody',
      );
      expect(text('/api/v1/admin/vitrina/algorithm', 'get')).toContain('200');
      expect(text('/api/v1/admin/vitrina/recompute', 'post')).toContain(
        'RECOMPUTE_IN_PROGRESS',
      );
      expect(text('/api/v1/admin/vitrina/preview', 'get')).toContain(
        '"name":"pinned"',
      );
    });
  });
});
