import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { resolve } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { Prisma } from './../src/generated/prisma/client.js';
import {
  FakeFxProvider,
  FAKE_FX_DEFAULT_DATE,
  FAKE_FX_FIXTURES,
} from './../src/fx/fake-fx.provider.js';
import { VitrinaScoringService } from './../src/vitrina/vitrina-scoring.service.js';
import { validBlock } from './../src/admin-landing/landing-blocks.fixtures.js';
import {
  restoreDailyStats,
  restoreFx,
  restoreLanding,
  snapshotDailyStats,
  snapshotFx,
  snapshotLanding,
  type DailyStatRows,
  type FxState,
} from './helpers/db-snapshot.js';
import {
  restoreVitrina,
  snapshotVitrina,
  type VitrinaSnapshot,
} from './helpers/vitrina-snapshot.js';

const TAG = randomUUID().slice(0, 8);
const USER = `e2e-epic18-${TAG}`;
const PASS = 'correct-horse-battery-staple-18-12';
const FX = '/api/v1/admin/fx';
const VIT = '/api/v1/admin/vitrina';
const LANDING = '/api/v1/admin/landing-content';
const VIT_ROW = { section: 'home', key: 'vitrina' };
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const D2 = new Date(FAKE_FX_DEFAULT_DATE.getTime() + 3600 * 1000);

/** Every table whose content must be byte-identical before and after. */
const TABLES = [
  'Landing_Config_Entries',
  'Fx_Rate_Settings',
  'Fx_Rate_Snapshots',
  'Fx_Setting_Audits',
  'Product_Daily_Stats',
  'Product_Score_Runs',
  'Product_Scores',
  'Vitrina_Algorithm_Settings',
  'Vitrina_Algorithm_Audits',
  'Orders',
  'Order_Lines',
  'Products',
] as const;

/** Host of a `Socket.connect(...)` call when it is not the local machine. */
export function externalHostOf(
  args: unknown[],
  allowed: string[] = [],
): string | null {
  // Node calls `Socket.prototype.connect` with a normalized `[options, cb]`
  // array (net.connect / http / tls), or with raw (port, host) / (path) args.
  const first = args[0];
  const a0: unknown = Array.isArray(first) ? (first[0] as unknown) : first;
  let host: string | undefined;
  if (typeof a0 === 'object' && a0 !== null) {
    const o = a0 as { host?: string; hostname?: string; path?: string };
    if (o.path) return null; // unix socket
    host = o.host ?? o.hostname ?? 'localhost';
  } else if (typeof a0 === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof a0 === 'string') {
    // (path) for a unix socket, (port-as-string, host) otherwise
    if (/^\d+$/.test(a0)) {
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else return null;
  }
  if (!host) return null;
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.startsWith('127.') ||
    h.startsWith('::ffff:127.') ||
    allowed.includes(h)
  ) {
    return null;
  }
  return host;
}

interface CheckoutBody {
  orderId: string;
  totalUsd: number;
  fxRateVesPerUsd: number | null;
  fxRateSource: string | null;
  totalVes: number | null;
  orderAccessToken: string;
}
interface StatusBody {
  source: string;
  rate: string;
  stale: boolean;
  hardStale: boolean;
  lastError: string | null;
  rejectedReading: unknown;
  result?: string;
}
interface PublicProduct {
  id: string;
}
interface VitrinaValue {
  products: PublicProduct[];
  vitrina?: {
    mode: string;
    size: number;
    items: { productId: string; source: string }[];
  };
}
interface PreviewItem {
  productId: string;
  score: number | null;
  components:
    (Record<string, { points: number }> & { scarcityFactor: number }) | null;
}

const body = (rail: 'pago_movil' | 'stripe') => ({
  paymentRail: rail,
  fulfillmentType: 'delivery',
  addressLine1: 'Av. Test 1',
  city: 'Caracas',
  state: 'Distrito Capital',
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
});

/**
 * Story 18.12 (AD-87): integral regression of Epic 18 against the real
 * Postgres. Provider FX is the fake one (a socket guard fails the suite if
 * anything leaves the machine). Everything it touches is snapshotted first and
 * restored byte for byte; the tables listed in TABLES are hashed before and
 * after and must be identical. Own products/orders carry their own ids and are
 * removed scores/stats -> orders -> products.
 */
describe('Epic 18 regression (e2e, Story 18.12)', { timeout: 120_000 }, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fake: FakeFxProvider;
  let scoring: VitrinaScoringService;
  let token: string;
  let adminId: string;
  let categoryId: string;
  let savedFx: FxState;
  let savedStats: DailyStatRows;
  let savedVit: VitrinaSnapshot;
  let savedLanding: Awaited<ReturnType<typeof snapshotLanding>>;
  let digestsBefore: Record<string, string>;
  let swagger: {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, { properties: object }> };
  };
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const id: Record<string, string> = {};
  const fiveXX: string[] = [];
  const external: string[] = [];
  // Negative test of the guard itself records here, never in `external`.
  const probed: string[] = [];
  let probing = false;
  const logged: string[] = [];
  const envBackup = { ...process.env };

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const digest = async (t: string) =>
    (
      await sql(
        `SELECT count(*)::int AS n,
                md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h
         FROM "${t}" x`,
      )
    )
      .map((r) => `${r.n as number}:${r.h as string}`)
      .join();
  const digests = async () => {
    const out: Record<string, string> = {};
    for (const t of TABLES) out[t] = await digest(t);
    return out;
  };

  const mkProduct = async (
    key: string,
    o: {
      franchise?: string;
      stock?: number;
      createdAt?: Date;
      category?: string;
      price?: string;
    } = {},
  ) => {
    const p = await prisma.product.create({
      data: {
        name: `E18 ${TAG} ${key}`,
        slug: `e18-${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 18.12.',
        franchise: (o.franchise ?? 'DRAGON_BALL_SUPER') as 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: o.price ?? '10.00',
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
        recipientName: 'E18 Tester',
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

  // ---- FX helpers --------------------------------------------------------
  const setRow = (
    source: string,
    rate: string,
    fetchedAgoH = 0,
    maxAgeHours = 48,
  ) =>
    prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "source" = ${source}::"FxRateSource",
        "vesPerUsd" = ${new Prisma.Decimal(rate)},
        "manualVesPerUsd" = ${source === 'MANUAL' ? new Prisma.Decimal(rate) : null},
        "maxAgeHours" = ${maxAgeHours}, "maxVariationPct" = 15,
        "rateFetchedAt" = now() - (${fetchedAgoH} * interval '1 hour'),
        "providerUpdatedAt" = NULL, "lastError" = NULL, "lastErrorAt" = NULL,
        "rejectedReading" = NULL
      WHERE "id" = 'default'`;
  const putFx = (b: object) =>
    request(server()).put(`${FX}/settings`).set(auth()).send(b);
  const refreshFx = () => request(server()).post(`${FX}/refresh`).set(auth());
  const statusFx = async () =>
    (await request(server()).get(`${FX}/status`).set(auth()).expect(200))
      .body as StatusBody;
  const current = () => request(server()).get('/api/v1/fx/current');
  const auditCount = () =>
    prisma.fxSettingAudit.count({ where: { adminUserId: adminId } });

  async function cart(productId: string, quantity = 2): Promise<string> {
    const res = await request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity })
      .expect(201);
    const set = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    return set.find((c) => c.startsWith('cartId='))!.split(';')[0];
  }
  const checkout = async (rail: 'pago_movil' | 'stripe') =>
    request(server())
      .post('/api/v1/checkout')
      .set('Cookie', await cart(id.FX))
      .send(body(rail));

  // ---- signals helpers ----------------------------------------------------
  const view = (productId: string, ip: string) =>
    request(server())
      .post(`/api/v1/products/${productId}/view`)
      .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0')
      .set('X-Forwarded-For', ip);
  const stat = async (productId: string) =>
    (
      await sql(
        `SELECT views, "cartAdds" FROM "Product_Daily_Stats"
         WHERE "productId" = $1::uuid AND day = (now() AT TIME ZONE 'UTC')::date`,
        [productId],
      )
    )[0] as { views: number; cartAdds: number } | undefined;

  // ---- vitrina helpers ----------------------------------------------------
  const runIds = async () =>
    (await sql(`SELECT id FROM "Product_Score_Runs"`)).map(
      (r) => r.id as string,
    );
  const currentRunId = async () =>
    (
      await sql(
        `SELECT "currentRunId" FROM "Vitrina_Algorithm_Settings" WHERE id='default'`,
      )
    )[0].currentRunId as string | null;
  const scoresOf = async (runId: string) =>
    await sql(
      `SELECT "productId", rank FROM "Product_Scores" WHERE "runId" = $1::uuid ORDER BY rank`,
      [runId],
    );
  const block = (ids: string[], extra: Record<string, unknown> = {}) => ({
    ...validBlock('vitrina', ids),
    ...extra,
  });
  const putDraft = (b: unknown) =>
    request(server())
      .put(`${LANDING}/blocks/vitrina`)
      .set(auth())
      .send(b as object);
  const publish = () =>
    request(server()).post(`${LANDING}/blocks/vitrina/publish`).set(auth());
  const publicVit = async () =>
    (
      (await request(server()).get('/api/v1/landing-content').expect(200))
        .body as { home?: { vitrina?: { value: VitrinaValue } } }
    ).home?.vitrina?.value;
  const draftVit = async () =>
    (
      (await request(server()).get(`${LANDING}/draft`).set(auth()).expect(200))
        .body as { blocks: { vitrina?: VitrinaValue } }
    ).blocks.vitrina;
  const idsOf = (v?: VitrinaValue) => (v?.products ?? []).map((p) => p.id);
  const A = (...ks: string[]) => ks.map((k) => id[k]);

  beforeAll(async () => {
    // Zero-network guard: any non-local socket / fetch is recorded.
    let dbHost = 'localhost';
    try {
      dbHost = new URL(process.env.DATABASE_URL ?? '').hostname || dbHost;
    } catch {
      /* keep default */
    }
    type Fn = (this: unknown, ...a: unknown[]) => unknown;
    const sock = net.Socket.prototype as unknown as Record<string, Fn>;
    const realConnect = sock.connect;
    vi.spyOn(sock, 'connect').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const h = externalHostOf(args, [dbHost.toLowerCase()]);
      if (h) (probing ? probed : external).push(h);
      return realConnect.apply(this, args);
    });
    const glob = globalThis as unknown as Record<string, Fn>;
    const realFetch = glob.fetch;
    vi.spyOn(glob, 'fetch').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const input = args[0] as string | URL | { url: string };
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const h = externalHostOf([{ host: new URL(url).hostname }]);
      if (h) external.push(h);
      return realFetch.apply(this, args);
    });

    const logProto = Logger.prototype as unknown as Record<string, Fn>;
    const realError = logProto.error;
    vi.spyOn(logProto, 'error').mockImplementation(function (
      this: unknown,
      ...a: unknown[]
    ) {
      logged.push(JSON.stringify(a));
      return realError.apply(this, a);
    });

    process.env.VIEW_RATE_LIMIT_PER_MIN = '1000000';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.use(
      (
        req: { method: string; path: string },
        res: { statusCode: number; on: (e: string, f: () => void) => void },
        next: () => void,
      ) => {
        res.on('finish', () => {
          if (res.statusCode >= 500)
            fiveXX.push(`${req.method} ${req.path} ${res.statusCode}`);
        });
        next();
      },
    );
    app.set('trust proxy', 1);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    ) as unknown as typeof swagger;
    // One shared listening server: 1 000 parallel requests would otherwise
    // open as many ephemeral servers (ECONNRESET).
    await app.listen(0);
    prisma = app.get(PrismaService);
    fake = app.get(FakeFxProvider).reset();
    scoring = app.get(VitrinaScoringService);

    // Snapshots BEFORE touching anything.
    digestsBefore = await digests();
    savedFx = await snapshotFx(prisma);
    savedStats = await snapshotDailyStats(prisma);
    savedVit = await snapshotVitrina(sql);
    savedLanding = await snapshotLanding(prisma, VIT_ROW);
    categoryId = (await prisma.category.findFirstOrThrow()).id;

    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: `${USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    // The suite owns the FX snapshots while it runs (restored in afterAll).
    await prisma.fxRateSnapshot.deleteMany();
    await mkProduct('FX', { franchise: 'NARUTO', stock: 5000, price: '12.34' });

    // --- Frente B fixture (PRD 19.6 A/B/C), all with own ids -------------
    await mkProduct('A', { createdAt: daysAgo(100) }); // 30 units, 60 d ago
    await mkProduct('B', { createdAt: daysAgo(100) }); // 8 units in 5 d
    await mkProduct('C', { createdAt: new Date() }); // new, 2 units
    await mkProduct('SOLD', { stock: 0, createdAt: daysAgo(100) });
    await mkProduct('D', { franchise: 'TOPPS', createdAt: daysAgo(100) }); // 1 sale
    await mkProduct('E', { franchise: 'TOPPS', createdAt: daysAgo(100) }); // 20 sales
    const catF = await prisma.category.create({
      data: { name: `E18 ${TAG} franchise`, slug: `e18-${TAG}-fr` },
    });
    const catM = await prisma.category.create({
      data: { name: `E18 ${TAG} pinned`, slug: `e18-${TAG}-pin` },
    });
    for (let i = 0; i < 10; i++)
      await mkProduct(`F${i}`, {
        franchise: 'OTHER',
        category: catF.id,
        createdAt: daysAgo(100),
      });
    for (const k of ['M1', 'M2', 'M3'])
      await mkProduct(k, { franchise: 'OTHER', category: catM.id });
    await mkOrder('PAID', [{ productId: id.A, qty: 30, at: daysAgo(60) }]);
    await mkOrder('PAID', [{ productId: id.B, qty: 4, at: daysAgo(5) }]);
    await mkOrder('FULFILLED', [{ productId: id.B, qty: 4, at: daysAgo(2) }]);
    await mkOrder('PAID', [{ productId: id.C, qty: 2, at: new Date() }]);
    await mkOrder('PAID', [{ productId: id.D, qty: 1, at: daysAgo(3) }]);
    await mkOrder('PAID', [{ productId: id.E, qty: 20, at: daysAgo(3) }]);
    await mkOrder('PAID', [{ productId: id.SOLD, qty: 20, at: daysAgo(1) }]);
    // Not PAID/FULFILLED: must never count (would make A beat B).
    await mkOrder('EXPIRED', [{ productId: id.A, qty: 50, at: daysAgo(1) }]);
    for (let i = 0; i < 10; i++)
      await mkOrder('PAID', [
        { productId: id[`F${i}`], qty: 1 + (i % 3), at: daysAgo(3) },
      ]);
  });

  afterAll(async () => {
    process.env = envBackup;
    vi.restoreAllMocks();
    // Order: scores/stats -> orders -> products (then the restores).
    await prisma.productScore.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.productDailyStat.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.order.deleteMany({
      where: {
        OR: [
          { id: { in: orderIds } },
          { lines: { some: { productId: { in: productIds } } } },
        ],
      },
    });
    await prisma.cart.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({
      where: { slug: { in: [`e18-${TAG}-fr`, `e18-${TAG}-pin`] } },
    });
    await prisma.landingConfigEntry.deleteMany({ where: VIT_ROW });
    await restoreLanding(prisma, VIT_ROW, savedLanding);
    await restoreDailyStats(prisma, savedStats);
    await restoreVitrina(sql, savedVit);
    await prisma.fxSettingAudit.deleteMany({ where: { adminUserId: adminId } });
    if (
      !(await prisma.fxRateSetting.findUnique({ where: { id: 'default' } }))
    ) {
      if (savedFx.setting)
        await prisma.fxRateSetting.create({
          data: { id: 'default', vesPerUsd: savedFx.setting.vesPerUsd },
        });
    }
    await restoreFx(prisma, savedFx);
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    // AC1: byte-identical tables.
    expect(await digests()).toEqual(digestsBefore);
    await app.close();
  });

  // ======================================================================
  describe('AC2: Frente A (tasa de cambio)', () => {
    it('zero network: the real spy records net.connect / http.request / tls.connect to an external host (and ignores local ones)', async () => {
      expect(externalHostOf([[{ host: '203.0.113.9', port: 80 }, null]])).toBe(
        '203.0.113.9',
      );
      expect(
        externalHostOf([[{ host: '127.0.0.1', port: 80 }, null]]),
      ).toBeNull();
      expect(externalHostOf([5432, 'localhost'])).toBeNull();
      expect(externalHostOf([{ path: '/tmp/x.sock' }])).toBeNull();
      expect(externalHostOf([443, '203.0.113.9'])).toBe('203.0.113.9');
      const attempt = (
        open: () => {
          destroy(): unknown;
          on(e: string, f: () => void): unknown;
        },
      ) =>
        new Promise<void>((done) => {
          const s = open();
          s.on('error', () => undefined);
          setTimeout(() => {
            s.destroy();
            done();
          }, 150);
        });
      probing = true;
      try {
        const T = '203.0.113.9'; // TEST-NET-3: never routable
        await attempt(() => net.connect({ host: T, port: 9 }));
        await attempt(() =>
          http.request({ host: T, port: 9, timeout: 100 }).end(),
        );
        await attempt(() => tls.connect({ host: T, port: 9 }));
        // Local connections must not be flagged.
        await attempt(() => net.connect({ host: '127.0.0.1', port: 9 }));
      } finally {
        probing = false;
      }
      expect(probed.filter((h) => h === '203.0.113.9')).toHaveLength(3);
      expect(probed).not.toContain('127.0.0.1');
      expect(external).toEqual([]);
      expect(fake.name).toBe('fake');
    });

    it('401 without an admin session on every FX and Vitrina admin route', async () => {
      const routes: Array<[string, string]> = [
        ['get', `${FX}/settings`],
        ['put', `${FX}/settings`],
        ['get', `${FX}/status`],
        ['post', `${FX}/refresh`],
        ['post', `${FX}/accept-rejected`],
        ['get', `${FX}/history`],
        ['get', `${FX}/audit`],
        ['get', `${VIT}/algorithm`],
        ['put', `${VIT}/algorithm`],
        ['get', `${VIT}/algorithm/audit`],
        ['post', `${VIT}/recompute`],
        ['get', `${VIT}/preview`],
      ];
      await setRow('MANUAL', '100.0000');
      const before = await auditCount();
      for (const [m, path] of routes) {
        const r = await (
          request(server()) as unknown as Record<
            string,
            (p: string) => request.Test
          >
        )[m](path);
        expect([m, path, r.status]).toEqual([m, path, 401]);
      }
      expect(await auditCount()).toBe(before);
    });

    it('PUT with each source changes the rate to that source and audits; /fx/current agrees', async () => {
      await setRow('MANUAL', '100.0000');
      const live = ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const;
      for (const source of live) {
        const before = await auditCount();
        const res = await putFx({ source }).expect(200);
        const expected = FAKE_FX_FIXTURES[source].toFixed(4);
        expect(res.body).toMatchObject({
          source,
          vesPerUsd: expected,
          stale: false,
          hardStale: false,
          refresh: 'UPDATED',
          sourceChanged: true,
        });
        expect(await auditCount()).toBe(before + 1);
        const cur = await current().expect(200);
        expect(cur.body).toMatchObject({ source, vesPerUsd: expected });
      }
      const before = await auditCount();
      const man = await putFx({ source: 'MANUAL', manualVesPerUsd: 912.5 });
      expect(man.status).toBe(200);
      expect(man.body).toMatchObject({
        vesPerUsd: '912.5000',
        source: 'MANUAL',
      });
      expect(await auditCount()).toBe(before + 1);
      const last = await prisma.fxSettingAudit.findFirstOrThrow({
        where: { adminUserId: adminId },
        orderBy: { createdAt: 'desc' },
      });
      expect(last).toMatchObject({
        fromSource: 'PARALELO_USD',
        toSource: 'MANUAL',
      });
    });

    it('provider down / NaN / 0 / +16 % never change the rate; status reflects it and Pago Movil keeps working', async () => {
      await prisma.fxRateSnapshot.deleteMany();
      await putFx({ source: 'BCV_USD' }).expect(200); // rate 889.2600, snapshot at D1
      const base = FAKE_FX_FIXTURES.BCV_USD.toFixed(4);
      const snaps = await prisma.fxRateSnapshot.count();
      const scenarios: Array<[string, () => void, boolean]> = [
        ['API down', () => fake.fail('boom'), false],
        ['NaN', () => fake.nan(D2), false],
        ['zero', () => fake.zero(D2), false],
        ['+16 %', () => fake.variation(FAKE_FX_FIXTURES.BCV_USD, 16, D2), true],
      ];
      for (const [name, arm, keepsReading] of scenarios) {
        fake.reset();
        arm();
        const r = await refreshFx().expect(200);
        const st = r.body as StatusBody;
        expect([name, st.rate, st.result !== 'UPDATED']).toEqual([
          name,
          base,
          true,
        ]);
        expect(st.lastError, name).not.toBeNull();
        if (keepsReading) expect(st.rejectedReading, name).not.toBeNull();
        expect((await statusFx()).rate).toBe(base);
        expect(
          ((await current().expect(200)).body as { vesPerUsd: string })
            .vesPerUsd,
        ).toBe(base);
        expect(await prisma.fxRateSnapshot.count()).toBe(snaps);
        const pm = await checkout('pago_movil');
        expect([name, pm.status]).toEqual([name, 201]);
        expect((pm.body as CheckoutBody).fxRateVesPerUsd).toBe(Number(base));
      }
      // Recovery: a sane, newer reading clears the error and moves the rate.
      fake.reset().succeed(900, D2);
      const ok = await refreshFx().expect(200);
      expect(ok.body).toMatchObject({
        result: 'UPDATED',
        rate: '900.0000',
        lastError: null,
      });
      fake.reset();
    });

    it('no rate at all => 503 FX_RATE_UNAVAILABLE on Pago Movil (and /fx/current); Stripe still 2xx', async () => {
      await prisma.fxRateSetting.deleteMany({ where: { id: 'default' } });
      try {
        const pm = await checkout('pago_movil');
        expect(pm.status).toBe(503);
        expect((pm.body as { errorCode: string }).errorCode).toBe(
          'FX_RATE_UNAVAILABLE',
        );
        const cur = await current();
        expect(cur.status).toBe(503);
        expect((cur.body as { errorCode: string }).errorCode).toBe(
          'FX_RATE_UNAVAILABLE',
        );
        expect((await checkout('stripe')).status).toBe(201);
      } finally {
        await prisma.fxRateSetting.create({
          data: { id: 'default', vesPerUsd: savedFx.setting!.vesPerUsd },
        });
        await setRow('BCV_USD', '889.2600');
      }
    });

    it('Pago Movil order stores fxRateSource/totalVes and never changes with the source; older orders have fxRateSource null', async () => {
      await prisma.fxRateSnapshot.deleteMany();
      await setRow('BCV_USD', '889.2600');
      const legacyId = await mkOrder('PAID', [
        { productId: id.FX, qty: 1, at: new Date() },
      ]);
      const res = await checkout('pago_movil');
      expect(res.status).toBe(201);
      const out = res.body as CheckoutBody;
      const cur = (await current().expect(200)).body as { vesPerUsd: string };
      expect(out.fxRateSource).toBe('BCV_USD');
      expect(out.fxRateVesPerUsd).toBe(Number(cur.vesPerUsd));
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: out.orderId },
      });
      const expectedVes = row.totalUsd.times('889.2600').toDecimalPlaces(2);
      expect(row.totalVes?.toFixed(2)).toBe(expectedVes.toFixed(2));
      expect(out.totalVes).toBe(expectedVes.toNumber());

      // Source and rate change afterwards: the order is untouched.
      await putFx({ source: 'BCV_EUR' }).expect(200);
      const after = await prisma.order.findUniqueOrThrow({
        where: { id: out.orderId },
      });
      expect(after.fxRateSource).toBe('BCV_USD');
      expect(after.fxRateVesPerUsd?.toFixed(4)).toBe('889.2600');
      expect(after.totalVes?.toFixed(2)).toBe(expectedVes.toFixed(2));
      const adm = await request(server())
        .get(`/api/v1/admin/orders/${out.orderId}`)
        .set(auth())
        .expect(200);
      expect(adm.body).toMatchObject({ fxRateSource: 'BCV_USD' });

      // Pre-epic order (no fx columns): null, never an error.
      const legacy = await request(server())
        .get(`/api/v1/admin/orders/${legacyId}`)
        .set(auth())
        .expect(200);
      expect((legacy.body as CheckoutBody).fxRateSource).toBeNull();
      // Stripe keeps all three null.
      const st = (await checkout('stripe')).body as CheckoutBody;
      expect([st.fxRateSource, st.fxRateVesPerUsd, st.totalVes]).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  // ======================================================================
  describe('AC3: concurrencia real (Promise.all)', () => {
    it('5 POST /admin/fx/refresh => exactly one snapshot and at most one with effect', async () => {
      fake.reset();
      await prisma.fxRateSnapshot.deleteMany();
      await prisma.fxRateSnapshot.create({
        data: {
          source: 'BCV_USD',
          rate: '880.0000',
          providerUpdatedAt: new Date('2026-10-30T12:00:00.000Z'),
        },
      });
      await setRow('BCV_USD', '880.0000');
      fake.succeed(889.26, FAKE_FX_DEFAULT_DATE);
      // Slow provider so the 5 readings are in flight together.
      const orig = fake.fetchRate.bind(fake);
      fake.fetchRate = async (s) => {
        await sleep(300);
        return orig(s);
      };
      let res: request.Response[];
      try {
        res = await Promise.all(Array.from({ length: 5 }, () => refreshFx()));
      } finally {
        fake.fetchRate = orig;
        fake.reset();
      }
      expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      for (const r of res.filter((x) => x.status === 409))
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'FX_REFRESH_IN_PROGRESS',
        );
      const updated = res.filter(
        (r) => r.status === 200 && (r.body as StatusBody).result === 'UPDATED',
      );
      expect(updated).toHaveLength(1);
      expect(
        await prisma.fxRateSnapshot.count({
          where: { source: 'BCV_USD', providerUpdatedAt: FAKE_FX_DEFAULT_DATE },
        }),
      ).toBe(1);
      expect(await prisma.fxRateSnapshot.count()).toBe(2);
      expect((await statusFx()).rate).toBe('889.2600');
    });

    it('1 000 POST /products/:id/view from ONE IP => views <= 1 (always 204); distinct IPs add up', async () => {
      await mkProduct('V', { franchise: 'NARUTO' });
      const statuses: number[] = [];
      for (let b = 0; b < 10; b++) {
        const r = await Promise.all(
          Array.from({ length: 100 }, () => view(id.V, '203.0.113.7')),
        );
        statuses.push(...r.map((x) => x.status));
      }
      expect(statuses).toHaveLength(1000);
      expect(statuses.every((s) => s === 204)).toBe(true);
      expect((await stat(id.V))?.views).toBe(1);
      await mkProduct('V2', { franchise: 'NARUTO' });
      const many = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          view(id.V2, `198.51.100.${i + 1}`),
        ),
      );
      expect(many.every((r) => r.status === 204)).toBe(true);
      expect((await stat(id.V2))?.views).toBe(30);
    });

    it('cartAdds grows by exactly 1 per addItem (also under concurrency) and by 0 when stock fails', async () => {
      await mkProduct('CA', { franchise: 'NARUTO', stock: 5 });
      const res = await request(server())
        .post('/api/v1/cart/items')
        .send({ productId: id.CA, quantity: 3 })
        .expect(201);
      const cookie = (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('cartId='))!
        .split(';')[0];
      expect((await stat(id.CA))?.cartAdds).toBe(1);
      await request(server())
        .post('/api/v1/cart/items')
        .set('Cookie', cookie)
        .send({ productId: id.CA, quantity: 10 })
        .expect(409);
      expect((await stat(id.CA))?.cartAdds).toBe(1);
      await mkProduct('CC', { franchise: 'NARUTO', stock: 100 });
      const many = await Promise.all(
        Array.from({ length: 20 }, () =>
          request(server())
            .post('/api/v1/cart/items')
            .send({ productId: id.CC, quantity: 1 }),
        ),
      );
      expect(many.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect((await stat(id.CC))?.cartAdds).toBe(20);
    });

    it('5 POST /admin/vitrina/recompute => one run, the rest 409 RECOMPUTE_IN_PROGRESS', async () => {
      const before = new Set(await runIds());
      const hold = vi
        .spyOn(
          scoring as unknown as { beforePointerSwap: () => Promise<void> },
          'beforePointerSwap',
        )
        .mockImplementation(async () => {
          await sleep(600);
        });
      let res: request.Response[];
      try {
        res = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(server()).post(`${VIT}/recompute`).set(auth()),
          ),
        );
      } finally {
        hold.mockRestore();
      }
      expect(res.map((r) => r.status).sort()).toEqual([
        200, 409, 409, 409, 409,
      ]);
      for (const r of res.filter((x) => x.status === 409))
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'RECOMPUTE_IN_PROGRESS',
        );
      const created = (await runIds()).filter((r) => !before.has(r));
      expect(created).toHaveLength(1);
      expect(created[0]).toBe(await currentRunId());
    });
  });

  // ======================================================================
  describe('AC4: Frente B (vitrina)', () => {
    let runId: string;

    it('PRD 19.6 A/B/C: B above A, C by novelty, 1 sale below 20 sales, sold out never, <= 4 per franchise, EXPIRED ignored', async () => {
      const res = await request(server())
        .post(`${VIT}/recompute`)
        .set(auth())
        .expect(200);
      runId = (res.body as { runId: string }).runId;
      const rows = await scoresOf(runId);
      const rank = (k: string) =>
        rows.find((r) => r.productId === id[k])?.rank as number | undefined;
      expect(rank('B')).toBeDefined();
      expect(rank('A')).toBeDefined();
      expect(rank('B')!).toBeLessThan(rank('A')!);
      expect(rank('C')).toBeDefined();
      expect(rank('E')).toBeDefined();
      // D (1 sale) is always ranked by the fixture; E (20 sales) must beat it.
      expect(rank('D')).toBeDefined();
      expect(rank('E')!).toBeLessThan(rank('D')!);
      expect(rank('SOLD')).toBeUndefined();
      const fr = Object.keys(id)
        .filter((k) => /^F\d$/.test(k))
        .map((k) => id[k]);
      expect(
        rows.filter((r) => fr.includes(r.productId as string)),
      ).toHaveLength(4);
      // Same input => same ranking.
      const now = new Date();
      const a = await scoring.recompute('ADMIN', now);
      const b = await scoring.recompute('ADMIN', now);
      if (a.status !== 'OK' || b.status !== 'OK') throw new Error('busy');
      const norm = async (r: string) =>
        (await scoresOf(r)).map((x) => [x.productId, x.rank]);
      expect(await norm(b.runId)).toEqual(await norm(a.runId));
      runId = b.runId;
    });

    it('preview breakdown adds up to the displayed score', async () => {
      const res = await request(server())
        .get(`${VIT}/preview`)
        .query({ mode: 'AUTO', size: 8 })
        .set(auth())
        .expect(200);
      const items = (res.body as { items: PreviewItem[] }).items;
      expect(items.length).toBeGreaterThan(0);
      for (const i of items) {
        const c = i.components!;
        const sum = ['sales', 'revenue', 'velocity', 'interest', 'novelty']
          .map((k) => c[k].points)
          .reduce((x, y) => x + y, 0);
        expect(
          Math.abs(sum * c.scarcityFactor - (i.score as number)),
        ).toBeLessThan(1e-3);
      }
    });

    it('MIXED (3 pinned + size 8) => 3 + 5 without duplicates; MANUAL equals the previous behaviour', async () => {
      await prisma.landingConfigEntry.deleteMany({ where: VIT_ROW });
      await putDraft(
        block(A('M3', 'B', 'M1'), { mode: 'MIXED', size: 8 }),
      ).expect(200);
      await publish().expect(200);
      const v = await publicVit();
      const ids = idsOf(v);
      expect(ids).toHaveLength(8);
      expect(ids.slice(0, 3)).toEqual(A('M3', 'B', 'M1'));
      expect(new Set(ids).size).toBe(8);
      expect(v?.vitrina?.items.map((i) => i.source)).toEqual([
        'pinned',
        'pinned',
        'pinned',
        'auto',
        'auto',
        'auto',
        'auto',
        'auto',
      ]);

      // MANUAL: exactly the pre-18.9 result (in stock only, same order, no `vitrina` key).
      await putDraft(
        block(A('M2', 'SOLD', 'M1'), { mode: 'MANUAL', size: 12 }),
      ).expect(200);
      await publish().expect(200);
      const m = await publicVit();
      expect(idsOf(m)).toEqual(A('M2', 'M1'));
      expect(m?.vitrina).toBeUndefined();
    });

    it('draft vs published keep their own mode over the same ranking', async () => {
      await putDraft(block(A('M1', 'M2'), { mode: 'MANUAL' })).expect(200);
      await publish().expect(200);
      await putDraft(block(A('M3'), { mode: 'AUTO', size: 5 })).expect(200);
      expect(idsOf(await publicVit())).toEqual(A('M1', 'M2'));
      const draft = await draftVit();
      expect(draft?.vitrina?.mode).toBe('AUTO');
      expect(idsOf(draft)).toHaveLength(5);
      await request(server())
        .delete(`${LANDING}/blocks/vitrina/draft`)
        .set(auth())
        .expect(204);
      expect(idsOf(await draftVit())).toEqual(A('M1', 'M2'));
    });

    it('a product that sells out disappears from AUTO without any recompute', async () => {
      await putDraft(block([], { mode: 'AUTO', size: 12 })).expect(200);
      await publish().expect(200);
      const own = new Set(productIds);
      const target = idsOf(await publicVit()).find((p) => own.has(p));
      expect(target).toBeDefined();
      const run = await currentRunId();
      await prisma.product.update({
        where: { id: target },
        data: { stock: 0 },
      });
      try {
        expect(idsOf(await publicVit())).not.toContain(target);
        expect(await currentRunId()).toBe(run);
      } finally {
        await prisma.product.update({
          where: { id: target },
          data: { stock: 50 },
        });
      }
    });

    it('empty ranking => fallback without 5xx: MIXED shows only the pinned ones, AUTO an empty list', async () => {
      const cur = await currentRunId();
      await sql(
        `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = NULL WHERE id='default'`,
      );
      try {
        await putDraft(
          block(A('M2', 'SOLD', 'M1'), { mode: 'MIXED', size: 8 }),
        ).expect(200);
        await publish().expect(200);
        expect(idsOf(await publicVit())).toEqual(A('M2', 'M1'));
        await putDraft(block(A('M1'), { mode: 'AUTO', size: 8 })).expect(200);
        await publish().expect(200);
        expect(await publicVit()).toMatchObject({ products: [] });
      } finally {
        await sql(
          `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = $1::uuid WHERE id='default'`,
          [cur],
        );
      }
    });
  });

  // ======================================================================
  describe('AC5/AC6: documentation, Swagger and global invariants', () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
    const section11 = () => {
      const d = read('docs/deployment.md');
      const i = d.indexOf('\n## 11.');
      expect(i).toBeGreaterThan(0);
      return d.slice(i);
    };
    /** Concatenated production sources (specs excluded). */
    const srcText = (): string => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = `${dir}/${e.name}`;
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
            out.push(readFileSync(p, 'utf8'));
        }
      };
      walk(resolve(process.cwd(), 'src'));
      return out.join('\n');
    };
    /** Backticked UPPER_SNAKE tokens of the subsection whose heading contains `title`. */
    const tokensOf = (doc: string, title: string): string[] => {
      const start = doc.indexOf(title);
      expect(start, title).toBeGreaterThan(0);
      const rest = doc.slice(start + title.length);
      const end = rest.search(/\n###? /);
      const part = end < 0 ? rest : rest.slice(0, end);
      return [...part.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map(
        (m) => m[1],
      );
    };

    it('deployment.md section 11: every cited errorCode exists literally in the code; every env var is documented and in .env.example', () => {
      const doc = section11();
      const code = srcText();
      const envs = tokensOf(doc, '### 11.1 ');
      expect(envs).toEqual(
        expect.arrayContaining([
          'FX_PROVIDER',
          'FX_PROVIDER_BASE_URL',
          'FX_PROVIDER_TIMEOUT_MS',
          'FX_REFRESH_CRON',
          'FX_REFRESH_ENABLED',
          'VITRINA_RECOMPUTE_CRON',
          'VITRINA_CRON_ENABLED',
          'VIEW_DEDUP_WINDOW_SEC',
          'VIEW_RATE_LIMIT_PER_MIN',
        ]),
      );
      const example = read('.env.example');
      for (const e of new Set(envs)) {
        expect(example, e).toMatch(new RegExp(`^#?\\s*${e}=`, 'm'));
        expect(code, e).toContain(e);
      }
      const codes = tokensOf(doc, '### 11.9 ');
      expect(codes).toEqual(
        expect.arrayContaining([
          'FX_RATE_UNAVAILABLE',
          'VITRINA_BUSY',
          'RECOMPUTE_IN_PROGRESS',
        ]),
      );
      for (const c of new Set(codes)) expect(code, c).toContain(`'${c}'`);
      for (const needle of [
        '$proxy_add_x_forwarded_for',
        'BACKEND_API_URL',
        'EnvironmentFile',
        'proxy_read_timeout',
        'prisma migrate deploy',
        'hardStale',
      ])
        expect(doc, needle).toContain(needle);
    });

    it('Swagger: new endpoints exist and carry their errorCodes', () => {
      const text = (path: string, m: string) =>
        JSON.stringify(swagger.paths[path]?.[m]);
      const need: Array<[string, string, string[]]> = [
        ['/api/v1/fx/current', 'get', ['FX_RATE_UNAVAILABLE']],
        ['/api/v1/checkout', 'post', ['FX_RATE_UNAVAILABLE']],
        ['/api/v1/admin/fx/settings', 'put', ['FX_MANUAL_RATE_REQUIRED']],
        ['/api/v1/admin/fx/refresh', 'post', ['FX_REFRESH_IN_PROGRESS']],
        [
          '/api/v1/admin/fx/accept-rejected',
          'post',
          ['FX_NO_REJECTED_READING', 'FX_REJECTED_READING_NOT_ACCEPTABLE'],
        ],
        [
          '/api/v1/admin/vitrina/algorithm',
          'put',
          ['VITRINA_WEIGHTS_INVALID', 'VITRINA_PARAMS_INVALID', 'VITRINA_BUSY'],
        ],
        ['/api/v1/admin/vitrina/recompute', 'post', ['RECOMPUTE_IN_PROGRESS']],
        ['/api/v1/admin/vitrina/preview', 'get', ['pinned']],
        ['/api/v1/admin/vitrina/algorithm/audit', 'get', ['200']],
        ['/api/v1/products/{id}/view', 'post', ['204']],
      ];
      for (const [path, m, needles] of need) {
        expect(swagger.paths[path]?.[m], `${m} ${path}`).toBeDefined();
        for (const n of needles)
          expect(text(path, m), `${m} ${path}`).toContain(n);
      }
    });

    it('Swagger: the PUT response schema documents the additive hardStale field', () => {
      expect(
        swagger.components.schemas.UpdateFxSettingsResponseDto.properties,
      ).toHaveProperty('hardStale');
    });

    it('no unexpected 5xx, no uncaught P2002 and no external connection were produced by the whole run; table hashes are verified in afterAll', () => {
      // Only the two 503 FX_RATE_UNAVAILABLE provoked on purpose (no rate row).
      expect(fiveXX).toEqual([
        'POST /api/v1/checkout 503',
        'GET /api/v1/fx/current 503',
      ]);
      expect(external).toEqual([]);
      expect(logged.join('|')).not.toContain('P2002');
    });
  });
});
