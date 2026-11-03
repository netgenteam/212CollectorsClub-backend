import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { Prisma } from './../src/generated/prisma/client.js';
import {
  FakeFxProvider,
  FAKE_FX_FIXTURES,
} from './../src/fx/fake-fx.provider.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';

const TAG = randomUUID().slice(0, 8);
const ADMIN_USERNAME = `e2e-admin-18-3-${TAG}`;
const ADMIN_PASSWORD = 'correct-horse-battery-staple-18-3';

interface CheckoutBody {
  orderId: string;
  totalUsd: number;
  fxRateVesPerUsd: number | null;
  fxRateSource: string | null;
  totalVes: number | null;
  orderAccessToken: string;
}
interface CurrentBody {
  vesPerUsd: string;
  source: string;
  updatedAt: string;
  stale: boolean;
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
 * Story 18.3 (AD-80, FR-92..94). Fake FX provider (zero network). The real
 * FX row/snapshots are snapshotted and restored; products/orders/carts are
 * created and removed by this suite only.
 */
describe('Checkout FX source + GET /fx/current (e2e, Story 18.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let saved: FxState;
  let productId: string;
  let adminId: string;
  let adminToken: string;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

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
        "maxAgeHours" = ${maxAgeHours},
        "rateFetchedAt" = now() - (${fetchedAgoH} * interval '1 hour'),
        "providerUpdatedAt" = NULL, "lastError" = NULL, "lastErrorAt" = NULL,
        "rejectedReading" = NULL
      WHERE "id" = 'default'`;

  async function cart(): Promise<string> {
    const res = await request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity: 2 })
      .expect(201);
    const set = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    return set.find((c) => c.startsWith('cartId='))!.split(';')[0];
  }
  const checkout = async (rail: 'pago_movil' | 'stripe') =>
    request(server())
      .post('/api/v1/checkout')
      .set('Cookie', await cart())
      .send(body(rail));
  const current = () => request(server()).get('/api/v1/fx/current');

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    // Story 18.12: ONE shared listening server. Without it supertest opens an
    // ephemeral server per request and the staggered/concurrent rounds of
    // "AC7 (real)" intermittently died with ECONNRESET (same fix as 18.7).
    await app.listen(0);
    prisma = app.get(PrismaService);
    saved = await snapshotFx(prisma);
    // Story 18.12: the suite owns the FX snapshot table while it runs (the
    // real ones are restored verbatim in afterAll). Foreign snapshots dated
    // after the fake provider's fixtures would turn every fresh reading into
    // DATE_REGRESSION; each test seeds the snapshots it needs.
    await prisma.fxRateSnapshot.deleteMany();
    const category = await prisma.category.findFirstOrThrow();
    productId = (
      await prisma.product.create({
        data: {
          name: `FX18.3 ${TAG}`,
          slug: `fx183-${TAG}`,
          description: 'Created by e2e 18.3.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '12.34',
          stock: 500,
          heldQty: 0,
          isActive: true,
          categoryId: category.id,
        },
      })
    ).id;
    const admin = await prisma.adminUser.create({
      data: {
        username: ADMIN_USERNAME,
        email: `${ADMIN_USERNAME}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    adminId = admin.id;
    const res = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .expect(200);
    adminToken = (res.body as { accessToken: string }).accessToken;
  });

  // Each test starts from an empty snapshot table and seeds what it needs
  // (a previous test may have left a future-dated one on purpose).
  beforeEach(async () => {
    await prisma.fxRateSnapshot.deleteMany();
  });

  afterAll(async () => {
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.order.deleteMany({
      where: { lines: { some: { productId } } },
    });
    await prisma.cart.deleteMany({ where: { items: { some: { productId } } } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.fxSettingAudit.deleteMany({ where: { adminUserId: adminId } });
    await prisma.adminUser.delete({ where: { id: adminId } });
    if (
      !(await prisma.fxRateSetting.findUnique({ where: { id: 'default' } }))
    ) {
      if (saved.setting)
        await prisma.fxRateSetting.create({
          data: { id: 'default', vesPerUsd: saved.setting.vesPerUsd },
        });
    }
    await restoreFx(prisma, saved);
    await app.close();
  });

  it('AC3/AC6: every source is snapshotted with its rate; changing the source later never alters the order; GET /fx/current matches', async () => {
    const cases: Array<[string, string]> = [
      ['BCV_USD', '889.2600'],
      ['BCV_EUR', '1034.5000'],
      ['PARALELO_USD', '950.1000'],
      ['MANUAL', '912.5000'],
    ];
    const orders: Array<{ id: string; source: string; rate: string }> = [];
    for (const [source, rate] of cases) {
      await setRow(source, rate);
      const cur = await current().expect(200);
      expect(cur.headers['cache-control']).toBe('public, max-age=30');
      const c = cur.body as CurrentBody;
      expect(Object.keys(c).sort()).toEqual(
        ['source', 'stale', 'updatedAt', 'vesPerUsd'].sort(),
      );
      expect(c).toMatchObject({ vesPerUsd: rate, source, stale: false });
      expect(new Date(c.updatedAt).toISOString()).toBe(c.updatedAt);

      const res = await checkout('pago_movil').then((r) => r);
      expect(res.status).toBe(201);
      const out = res.body as CheckoutBody;
      expect(out.fxRateSource).toBe(source);
      expect(out.fxRateVesPerUsd).toBe(Number(rate));
      expect(out.fxRateVesPerUsd).toBe(Number(c.vesPerUsd));
      const expectedVes = new Prisma.Decimal('24.68')
        .times(rate)
        .toDecimalPlaces(2);
      expect(out.totalVes).toBe(expectedVes.toNumber());
      orders.push({ id: out.orderId, source, rate });
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: out.orderId },
      });
      expect(row.fxRateSource).toBe(source);
      expect(row.fxRateVesPerUsd?.toFixed(4)).toBe(rate);
      expect(row.totalVes?.toFixed(2)).toBe(expectedVes.toFixed(2));

      const look = await request(server())
        .get(`/api/v1/orders/${out.orderId}`)
        .set('Authorization', `Bearer ${out.orderAccessToken}`)
        .expect(200);
      expect((look.body as CheckoutBody).fxRateSource).toBe(source);
    }
    // Source/rate changed afterwards: existing orders are untouched.
    await setRow('BCV_USD', '1.0000');
    for (const o of orders) {
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(row.fxRateSource).toBe(o.source);
      expect(row.fxRateVesPerUsd?.toFixed(4)).toBe(o.rate);
    }
    // Admin order view exposes it too.
    const adm = await request(server())
      .get(`/api/v1/admin/orders/${orders[1].id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((adm.body as CheckoutBody).fxRateSource).toBe('BCV_EUR');
  });

  it('AC3: Stripe orders keep fxRateSource/fxRateVesPerUsd/totalVes null', async () => {
    await setRow('BCV_USD', '889.2600');
    const res = await checkout('stripe');
    expect(res.status).toBe(201);
    const out = res.body as CheckoutBody;
    expect(out.fxRateSource).toBeNull();
    expect(out.fxRateVesPerUsd).toBeNull();
    expect(out.totalVes).toBeNull();
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: out.orderId },
    });
    expect(row.fxRateSource).toBeNull();
  });

  it('AC2/AC6: rate row absent => 503 FX_RATE_UNAVAILABLE on Pago Movil and /fx/current, Stripe still 2xx', async () => {
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
        data: { id: 'default', vesPerUsd: saved.setting!.vesPerUsd },
      });
    }
    // No Order was created by the failed Pago Movil attempt (rolled back).
  });

  it('AC2: rate <= 0 is unavailable (DB CHECK may forbid it; raw 0 attempted)', async () => {
    // vesPerUsd has no CHECK; set 0 and verify the service rejects it.
    await setRow('BCV_USD', '0.0000');
    expect((await checkout('pago_movil')).status).toBe(503);
    expect((await current()).status).toBe(503);
  });

  it('AC2/AC6: between maxAgeHours and x3 operates (stale:true); beyond x3 => 503; MANUAL never expires', async () => {
    await setRow('BCV_USD', '889.2600', 60); // 48h < 60h <= 144h
    const cur = await current().expect(200);
    expect((cur.body as CurrentBody).stale).toBe(true);
    expect((await checkout('pago_movil')).status).toBe(201);

    await setRow('BCV_USD', '889.2600', 145);
    expect((await current()).status).toBe(503);
    const bad = await checkout('pago_movil');
    expect(bad.status).toBe(503);
    expect((bad.body as { errorCode: string }).errorCode).toBe(
      'FX_RATE_UNAVAILABLE',
    );
    expect((await checkout('stripe')).status).toBe(201);

    await setRow('MANUAL', '500.0000', 9999);
    const m = await current().expect(200);
    expect((m.body as CurrentBody).stale).toBe(false);
    expect((await checkout('pago_movil')).status).toBe(201);
  });

  it('AC7: N concurrent checkouts while the rate/source flips => each order holds a coherent (source, rate) pair, no 5xx', async () => {
    const pairs: Array<[string, string]> = [
      ['BCV_USD', '889.2600'],
      ['BCV_EUR', '1034.5000'],
      ['PARALELO_USD', '950.1000'],
      ['MANUAL', '912.5000'],
    ];
    await setRow(...pairs[0]);
    const cookies = await Promise.all(Array.from({ length: 12 }, () => cart()));
    let stop = false;
    const flipper = (async () => {
      let i = 0;
      while (!stop) {
        // ONE statement: source and rate always change together.
        await setRow(...pairs[i++ % pairs.length]);
      }
    })();
    let results: request.Response[];
    try {
      results = await Promise.all(
        cookies.map((c) =>
          request(server())
            .post('/api/v1/checkout')
            .set('Cookie', c)
            .send(body('pago_movil')),
        ),
      );
    } finally {
      stop = true;
      await flipper;
    }
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seen = new Set<string>();
    for (const r of results) {
      const out = r.body as CheckoutBody;
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: out.orderId },
      });
      const key = `${row.fxRateSource}:${row.fxRateVesPerUsd?.toFixed(4)}`;
      seen.add(key);
      expect(pairs.map(([s, v]) => `${s}:${v}`)).toContain(key);
      const expectedVes = row.totalUsd
        .times(row.fxRateVesPerUsd!)
        .toDecimalPlaces(2);
      expect(row.totalVes?.toFixed(2)).toBe(expectedVes.toFixed(2));
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  }, 30_000); // Story 19.3b: 12 checkouts + a flipper hit the default 5 s test timeout under load

  it('AC7: checkouts concurrent with admin PUT source changes never 5xx and stay coherent with a real source', async () => {
    await setRow('MANUAL', '300.0000');
    const cookies = await Promise.all(Array.from({ length: 8 }, () => cart()));
    const put = (b: object) =>
      request(server())
        .put('/api/v1/admin/fx/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(b);
    const [puts, checkouts] = await Promise.all([
      Promise.all([
        put({ source: 'MANUAL', manualVesPerUsd: 111 }),
        put({ source: 'BCV_EUR' }),
        put({ source: 'MANUAL', manualVesPerUsd: 222 }),
        put({ source: 'BCV_USD' }),
      ]),
      Promise.all(
        cookies.map((c) =>
          request(server())
            .post('/api/v1/checkout')
            .set('Cookie', c)
            .send(body('pago_movil')),
        ),
      ),
    ]);
    expect(puts.every((r) => r.status < 500)).toBe(true);
    expect(checkouts.every((r) => r.status === 201)).toBe(true);
    for (const r of checkouts) {
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: (r.body as CheckoutBody).orderId },
      });
      expect(row.fxRateSource).not.toBeNull();
      expect(row.fxRateVesPerUsd!.gt(0)).toBe(true);
    }
  });

  // ---- QA 18.3 fix: source and rate change atomically (AD-79) -------------
  const validPairs = () =>
    new Set(
      (['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const).map(
        (s) => `${s}:${FAKE_FX_FIXTURES[s].toFixed(4)}`,
      ),
    );
  const putSettings = (b: object) =>
    request(server())
      .put('/api/v1/admin/fx/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(b);
  const orderPair = async (r: request.Response) => {
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: (r.body as CheckoutBody).orderId },
    });
    return `${row.fxRateSource}:${row.fxRateVesPerUsd?.toFixed(4)}`;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('AC7 (real): staggered checkouts during PUT source changes (several rounds) always store a real (source, rate) pair', async () => {
    const fake = app.get(FakeFxProvider).reset();
    const valid = validPairs();
    await setRow('BCV_USD', '889.2600');
    const order = ['PARALELO_USD', 'BCV_EUR', 'BCV_USD', 'PARALELO_USD'];
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const cookies: string[] = [];
      for (let i = 0; i < 20; i++) cookies.push(await cart());
      const checkouts: Array<Promise<request.Response>> = [];
      const puts = (async () => {
        for (const source of order) {
          const r = await putSettings({ source });
          expect(r.status).toBe(200);
          await sleep(3);
        }
      })();
      for (const c of cookies) {
        checkouts.push(
          Promise.resolve(
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', c)
              .send(body('pago_movil')),
          ),
        );
        await sleep(2);
      }
      await puts;
      for (const r of await Promise.all(checkouts)) {
        expect(r.status).toBe(201);
        const key = await orderPair(r);
        seen.add(key);
        expect(valid.has(key), key).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it('refresh of the new source FAILS: no order and no /fx/current exposes a mixed pair (with and without a snapshot)', async () => {
    const fake = app.get(FakeFxProvider).reset();
    const valid = validPairs();
    await prisma.fxRateSnapshot.deleteMany();
    await setRow('BCV_USD', '889.2600');
    fake.fail('provider down');
    // No snapshot of PARALELO_USD: nothing changes.
    const noSnap = await putSettings({ source: 'PARALELO_USD' }).expect(200);
    expect(noSnap.body).toMatchObject({
      source: 'BCV_USD',
      stale: true,
      sourceChanged: false,
    });
    expect(((await current().expect(200)).body as CurrentBody).source).toBe(
      'BCV_USD',
    );
    // With a snapshot of PARALELO_USD: switches to ITS rate.
    await prisma.fxRateSnapshot.create({
      data: {
        source: 'PARALELO_USD',
        rate: FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4),
        providerUpdatedAt: new Date(),
        fetchedAt: new Date(),
      },
    });
    const cookies = await Promise.all(Array.from({ length: 10 }, () => cart()));
    const checkouts: Array<Promise<request.Response>> = [];
    const put = putSettings({ source: 'PARALELO_USD' });
    for (const c of cookies) {
      checkouts.push(
        Promise.resolve(
          request(server())
            .post('/api/v1/checkout')
            .set('Cookie', c)
            .send(body('pago_movil')),
        ),
      );
      await sleep(2);
    }
    expect((await put).status).toBe(200);
    for (const r of await Promise.all(checkouts)) {
      expect(r.status).toBe(201);
      expect(valid.has(await orderPair(r))).toBe(true);
    }
    const cur = (await current().expect(200)).body as CurrentBody;
    expect(valid.has(`${cur.source}:${cur.vesPerUsd}`)).toBe(true);
    const after = await checkout('pago_movil');
    expect(valid.has(await orderPair(after))).toBe(true);
  });

  it('refresh of the new source is REJECTED (DATE_REGRESSION): pair stays coherent in orders and /fx/current', async () => {
    const fake = app.get(FakeFxProvider).reset();
    const valid = validPairs();
    await prisma.fxRateSnapshot.deleteMany();
    await setRow('BCV_USD', '889.2600');
    // Future-dated snapshot => the fixture reading (2026-11-01) regresses.
    await prisma.fxRateSnapshot.create({
      data: {
        source: 'PARALELO_USD',
        rate: FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4),
        providerUpdatedAt: new Date(Date.now() + 2 * 3600 * 1000),
      },
    });
    const res = await putSettings({ source: 'PARALELO_USD' }).expect(200);
    expect(res.body).toMatchObject({
      refresh: 'REJECTED',
      reason: 'DATE_REGRESSION',
      source: 'PARALELO_USD',
      vesPerUsd: FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4),
    });
    const cur = (await current().expect(200)).body as CurrentBody;
    expect(`${cur.source}:${cur.vesPerUsd}`).toBe(
      `PARALELO_USD:${FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4)}`,
    );
    const r = await checkout('pago_movil');
    expect(r.status).toBe(201);
    expect(valid.has(await orderPair(r))).toBe(true);
    expect(fake.calls).toContain('PARALELO_USD');
  });

  it('Swagger documents GET /fx/current and 503 FX_RATE_UNAVAILABLE on checkout', async () => {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    ) as unknown as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    expect(doc.paths['/api/v1/fx/current'].get.responses['200']).toBeDefined();
    expect(doc.paths['/api/v1/fx/current'].get.responses['503']).toBeDefined();
    expect(doc.paths['/api/v1/checkout'].post.responses['503']).toBeDefined();
  });
});
