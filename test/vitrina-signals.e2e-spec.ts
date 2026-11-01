import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { vi } from 'vitest';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  ProductSignalsService,
  utcDay,
} from './../src/vitrina/product-signals.service.js';
import {
  restoreDailyStats,
  snapshotDailyStats,
  type DailyStatRows,
} from './helpers/db-snapshot.js';

const TAG = randomUUID().slice(0, 8);
const PASSWORD = 'correct-horse-battery-18-7';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0';

/**
 * Story 18.7 (AD-82): view/cartAdds signals against the real Postgres.
 * Fixtures are tagged; `Product_Daily_Stats` is snapshotted and restored.
 */
describe('Vitrina signals (e2e, Story 18.7)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let signals: ProductSignalsService;
  let snapshot: DailyStatRows;
  let categoryId: string;
  const productIds: string[] = [];
  const emails: string[] = [];
  const envBackup = { ...process.env };
  const today = () => utcDay(new Date());
  const server = () => app.getHttpServer();

  const mk = async (key: string, stock = 100, isActive = true) => {
    const p = await prisma.product.create({
      data: {
        name: `Sig${TAG} ${key}`,
        slug: `sig${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 18.7.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '5.00',
        stock,
        heldQty: 0,
        isActive,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  };

  const stat = async (productId: string, day = today()) => {
    const rows = await prisma.$queryRaw<{ views: number; cartAdds: number }[]>`
      SELECT views, "cartAdds" FROM "Product_Daily_Stats"
      WHERE "productId" = ${productId}::uuid AND day = ${day}::date`;
    return rows[0] ?? null;
  };
  const view = (id: string, ip?: string, ua: string | null = UA) => {
    const r = request(server()).post(`/api/v1/products/${id}/view`);
    if (ua !== null) r.set('User-Agent', ua);
    if (ip) r.set('X-Forwarded-For', ip);
    return r;
  };
  const addCart = (productId: string, quantity: number, cookie?: string) => {
    const r = request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity });
    return cookie ? r.set('Cookie', cookie) : r;
  };

  beforeAll(async () => {
    process.env.VIEW_RATE_LIMIT_PER_MIN = '1000000';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Only the auth throttle (register/login) is bypassed; the view guard is a distinct class.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.set('trust proxy', 1);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    // One shared listening server: hundreds of parallel requests would otherwise open as many ephemeral servers (ECONNRESET).
    await app.listen(0);
    prisma = app.get(PrismaService);
    signals = app.get(ProductSignalsService);
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    snapshot = await snapshotDailyStats(prisma);
  });

  afterAll(async () => {
    process.env = envBackup;
    await prisma.cart.deleteMany({
      where: { customer: { email: { in: emails } } },
    });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await prisma.cart.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await restoreDailyStats(prisma, snapshot);
    await app.close();
  });

  describe('AC1-AC4: POST /products/:id/view', () => {
    it('1000 views from the same IP (batched Promise.all) => views <= 1, always 204', async () => {
      const id = await mk('same-ip');
      const statuses: number[] = [];
      for (let b = 0; b < 10; b++) {
        const res = await Promise.all(
          Array.from({ length: 100 }, () => view(id, '203.0.113.7')),
        );
        statuses.push(...res.map((r) => r.status));
        expect(res[0].text).toBe('');
      }
      expect(statuses).toHaveLength(1000);
      expect(statuses.every((s) => s === 204)).toBe(true);
      expect((await stat(id))?.views).toBe(1);
    });

    it('distinct IPs (X-Forwarded-For) sum exactly under real concurrency, no 5xx', async () => {
      const id = await mk('many-ips');
      const res = await Promise.all(
        Array.from({ length: 60 }, (_, i) => view(id, `198.51.100.${i + 1}`)),
      );
      expect(res.every((r) => r.status === 204)).toBe(true);
      expect((await stat(id))?.views).toBe(60);
    });

    it('bot / empty UA / GPC / DNT => 204 without counting', async () => {
      const id = await mk('bots');
      for (const ua of [
        'Googlebot/2.1',
        'curl/8.4',
        'HeadlessChrome/120',
        '',
      ]) {
        await view(id, '192.0.2.1', ua).expect(204);
      }
      await view(id, '192.0.2.2', null).expect(204); // no UA header at all
      await view(id, '192.0.2.3').set('Sec-GPC', '1').expect(204);
      await view(id, '192.0.2.4').set('DNT', '1').expect(204);
      expect(await stat(id)).toBeNull();
      // DNT: 0 / GPC: 0 are not opt-outs
      await view(id, '192.0.2.5')
        .set('DNT', '0')
        .set('Sec-GPC', '0')
        .expect(204);
      expect((await stat(id))?.views).toBe(1);
    });

    it('unknown and inactive products => 204 and no row; malformed id => 400', async () => {
      const inactive = await mk('inactive', 10, false);
      const ghost = randomUUID();
      await view(ghost, '192.0.2.10').expect(204);
      await view(inactive, '192.0.2.11').expect(204);
      expect(await stat(ghost)).toBeNull();
      expect(await stat(inactive)).toBeNull();
      await view('not-a-uuid', '192.0.2.12').expect(400);
    });

    it('over the rate limit it still answers 204 (no 429) but stops counting', async () => {
      process.env.VIEW_RATE_LIMIT_PER_MIN = '3';
      try {
        const ids = await Promise.all(
          Array.from({ length: 6 }, (_, i) => mk(`rl${i}`)),
        );
        const statuses: number[] = [];
        for (const id of ids) {
          statuses.push((await view(id, '192.0.2.99')).status);
        }
        expect(statuses.every((s) => s === 204)).toBe(true);
        const counted = (await Promise.all(ids.map((i) => stat(i)))).filter(
          Boolean,
        );
        expect(counted).toHaveLength(3);
      } finally {
        process.env.VIEW_RATE_LIMIT_PER_MIN = '1000000';
      }
    });

    it('persists and logs no IP / UA anywhere', async () => {
      const ip = '203.0.113.222';
      const marker = `UA-MARKER-${TAG}`;
      const id = await mk('privacy');
      const calls: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (m) =>
          vi
            .spyOn(Logger.prototype, m)
            .mockImplementation((...a: unknown[]) => {
              calls.push(JSON.stringify(a));
            }),
      );
      const con = vi
        .spyOn(console, 'log')
        .mockImplementation(
          (...a: unknown[]) => void calls.push(JSON.stringify(a)),
        );
      try {
        await view(id, ip, `Mozilla ${marker}`).expect(204);
        await view(id, ip, `Mozilla ${marker}`).expect(204);
      } finally {
        spies.forEach((s) => s.mockRestore());
        con.mockRestore();
      }
      expect(calls.join('|')).not.toContain(ip);
      expect(calls.join('|')).not.toContain(marker);
      const cols = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'Product_Daily_Stats' ORDER BY column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([
        'cartAdds',
        'day',
        'productId',
        'views',
      ]);
    });

    it('Swagger documents the endpoint with 204', () => {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').build(),
      );
      const op = doc.paths['/api/v1/products/{id}/view']?.post;
      expect(op?.responses?.['204']).toBeDefined();
      expect(op?.description).toContain('204');
    });
  });

  describe('AC5: cartAdds server-side', () => {
    it('guest addItem counts one event (not units); stock failure and updateQuantity do not', async () => {
      const id = await mk('cart-guest', 5);
      const res = await addCart(id, 3).expect(201);
      const cookie = (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('cartId='))!
        .split(';')[0];
      expect((await stat(id))?.cartAdds).toBe(1);
      // exceeds stock -> 409 and the counter does not move
      await addCart(id, 10, cookie).expect(409);
      expect((await stat(id))?.cartAdds).toBe(1);
      await request(server())
        .patch(`/api/v1/cart/items/${id}`)
        .set('Cookie', cookie)
        .send({ quantity: 2 })
        .expect(200);
      expect((await stat(id))?.cartAdds).toBe(1);
      await addCart(id, 1, cookie).expect(201);
      expect((await stat(id))?.cartAdds).toBe(2);
    });

    it('account addItem counts; insufficient stock does not', async () => {
      const id = await mk('cart-acct', 2);
      const email = `e2e-18-7-${TAG}@212collectorsclub.test`;
      emails.push(email);
      await request(server())
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, name: 'Sig Tester' })
        .expect(201);
      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const session = (login.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('cc_session='))!
        .split(';')[0];
      await addCart(id, 1, session).expect(201);
      expect((await stat(id))?.cartAdds).toBe(1);
      await addCart(id, 5, session).expect(409);
      expect((await stat(id))?.cartAdds).toBe(1);
    });

    it('20 concurrent addItem on a product without a row today => exact count, no 5xx', async () => {
      const id = await mk('cart-conc', 100);
      expect(await stat(id)).toBeNull();
      const res = await Promise.all(
        Array.from({ length: 20 }, () => addCart(id, 1)),
      );
      expect(res.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect((await stat(id))?.cartAdds).toBe(20);
    });

    it('views and cartAdds on the same row do not clobber each other', async () => {
      const id = await mk('mixed', 100);
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => view(id, `198.18.0.${i + 1}`)),
        ...Array.from({ length: 10 }, () => addCart(id, 1)),
      ]);
      const s = await stat(id);
      expect(s).toEqual({ views: 10, cartAdds: 10 });
    });
  });

  describe('AC7: retention purge', () => {
    it('removes day < today-180 only, idempotent, batched', async () => {
      const id = await mk('purge');
      const now = new Date('2026-06-30T12:00:00Z'); // cutoff 2026-01-01 (exclusive)
      const days = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-06-30'];
      for (const d of days) {
        await prisma.$executeRaw`INSERT INTO "Product_Daily_Stats" ("productId", "day", "views", "cartAdds")
          VALUES (${id}::uuid, ${d}::date, 1, 1)`;
      }
      expect(await signals.purgeOldStats(now, 1)).toBe(2);
      expect(await stat(id, '2025-12-30')).toBeNull();
      expect(await stat(id, '2025-12-31')).toBeNull();
      expect(await stat(id, '2026-01-01')).not.toBeNull();
      expect(await stat(id, '2026-06-30')).not.toBeNull();
      expect(await signals.purgeOldStats(now, 1)).toBe(0);
    });
  });
});
