import { createHmac, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface WishlistBody {
  data: { id: string; name: string }[];
  productIds: string[];
}

// Story 11.5 (FR-36, AD-22): anonymous wishlist via signed cookie.
describe('Wishlist (e2e, Story 11.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let secret: string;
  let categoryId: string;
  const startedAt = new Date();
  const createdIds: string[] = [];
  const token = `Wsh${randomUUID().slice(0, 6)}`;
  let a: string;
  let b: string;
  let inactive: string;

  const mk = async (key: string, isActive = true) => {
    const p = await prisma.product.create({
      data: {
        name: `${token} ${key}`,
        slug: `${token.toLowerCase()}-${key}`,
        description: 'Created by e2e 11.5.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock: 5,
        heldQty: 0,
        isActive,
        categoryId,
      },
    });
    createdIds.push(p.id);
    return p.id;
  };

  const cookieOf = (res: request.Response): string => {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    const c = set?.find((x) => x.startsWith('wishlistId='));
    if (!c) throw new Error(`no wishlistId cookie: ${JSON.stringify(set)}`);
    return c;
  };
  const sign = (value: string) =>
    encodeURIComponent(
      `s:${value}.${createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')}`,
    );

  const post = (productId: unknown, cookie?: string) => {
    const r = request(app.getHttpServer())
      .post('/api/v1/wishlist/items')
      .send({ productId });
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const get = (cookie?: string) => {
    const r = request(app.getHttpServer()).get('/api/v1/wishlist');
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const del = (productId: string, cookie?: string) => {
    const r = request(app.getHttpServer()).delete(
      `/api/v1/wishlist/items/${productId}`,
    );
    return cookie ? r.set('Cookie', cookie) : r;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const configService = app.get(ConfigService);
    secret = configService.getOrThrow<string>('COOKIE_SECRET');
    app.use(cookieParser(secret));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    categoryId = (
      await prisma.category.create({
        data: { name: `${token} cat`, slug: `${token.toLowerCase()}-cat` },
      })
    ).id;
    a = await mk('a');
    b = await mk('b');
    inactive = await mk('off', false);
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.wishlist.deleteMany({
      where: { createdAt: { gte: startedAt }, items: { none: {} } },
    });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: token.toLowerCase() } },
    });
    await app.close();
  });

  it('schema: unique (wishlistId, productId) and cascade from Wishlist', async () => {
    const w = await prisma.wishlist.create({
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.wishlistItem.create({
      data: { wishlistId: w.id, productId: a },
    });
    await expect(
      prisma.wishlistItem.create({ data: { wishlistId: w.id, productId: a } }),
    ).rejects.toThrow();
    await prisma.wishlist.delete({ where: { id: w.id } });
    expect(
      await prisma.wishlistItem.count({ where: { wishlistId: w.id } }),
    ).toBe(0);
  });

  it('GET without cookie / forged / bad signature / unknown or expired wishlist -> 200 empty', async () => {
    const expired = await prisma.wishlist.create({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.wishlistItem.create({
      data: { wishlistId: expired.id, productId: a },
    });
    const cookies = [
      undefined,
      `wishlistId=${randomUUID()}`,
      `wishlistId=${encodeURIComponent(`s:${randomUUID()}.AAAA`)}`,
      'wishlistId=s%3Anot-a-uuid.zzz',
      `wishlistId=${sign(randomUUID())}`,
      `wishlistId=${sign('not-a-uuid')}`,
      `wishlistId=${sign(expired.id)}`,
    ];
    for (const c of cookies) {
      const res = await get(c).expect(200);
      expect(res.body).toEqual({ data: [], productIds: [] });
    }
  });

  it('POST creates the wishlist, sets a signed HttpOnly 30-day cookie, is idempotent; GET/DELETE round trip', async () => {
    const first = await post(a).expect(200);
    expect(first.body).toEqual({ productIds: [a] });
    const cookie = cookieOf(first);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(decodeURIComponent(cookie)).toMatch(/^wishlistId=s:/);
    const jar = cookie.split(';')[0];

    const again = await post(a, jar).expect(200);
    expect(again.body).toEqual({ productIds: [a] });
    const second = await post(b, jar).expect(200);
    expect((second.body as WishlistBody).productIds).toEqual([b, a]);

    const list = await get(jar).expect(200);
    const body = list.body as WishlistBody;
    expect(body.productIds).toEqual([b, a]);
    expect(body.data.map((d) => d.id)).toEqual([b, a]);

    await del(a, jar).expect(204);
    await del(a, jar).expect(204);
    expect(
      ((await get(jar).expect(200)).body as WishlistBody).productIds,
    ).toEqual([b]);
  });

  it('two concurrent identical POSTs -> both 200, exactly one row, no 500', async () => {
    const seed = await post(a).expect(200);
    const jar = cookieOf(seed).split(';')[0];
    await del(a, jar).expect(204);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(a, jar)),
    );
    for (const r of results) expect(r.status).toBe(200);
    const wid = decodeURIComponent(jar.split('=')[1]).slice(2).split('.')[0];
    expect(
      await prisma.wishlistItem.count({
        where: { wishlistId: wid, productId: a },
      }),
    ).toBe(1);
  });

  it('concurrent POSTs without cookie each get their own wishlist, never 500', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post(b)));
    for (const r of results) expect(r.status).toBe(200);
  });

  it('POST validation: non-UUID 400, unknown 404, inactive 404', async () => {
    await post('nope').expect(400);
    await post(undefined).expect(400);
    await post(randomUUID()).expect(404);
    await post(inactive).expect(404);
  });

  it('DELETE: non-UUID 400; no cookie / not saved 204', async () => {
    await del('nope').expect(400);
    await del(a).expect(204);
    await del(randomUUID(), `wishlistId=${randomUUID()}`).expect(204);
  });

  it('a product deactivated after saving disappears from data and productIds', async () => {
    const c = await mk('later');
    const jar = cookieOf(await post(c).expect(200)).split(';')[0];
    await post(a, jar).expect(200);
    await prisma.product.update({
      where: { id: c },
      data: { isActive: false },
    });
    const body = (await get(jar).expect(200)).body as WishlistBody;
    expect(body.productIds).toEqual([a]);
    expect(body.data.map((d) => d.id)).toEqual([a]);
  });

  it('a different cookie never sees another wishlist; wishlist cookie does not affect the cart', async () => {
    const jar1 = cookieOf(await post(a).expect(200)).split(';')[0];
    const jar2 = cookieOf(await post(b).expect(200)).split(';')[0];
    expect(((await get(jar1)).body as WishlistBody).productIds).toEqual([a]);
    expect(((await get(jar2)).body as WishlistBody).productIds).toEqual([b]);
    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Cookie', jar1)
      .expect(200);
    expect(cart.body).toEqual({ items: [], total: 0 });
  });

  it('the 201st distinct item -> 409 WISHLIST_FULL; repeating a saved one at the cap is still 200', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) ids.push(await mk(`cap${i}`));
    const first = await post(ids[0]).expect(200);
    const jar = cookieOf(first).split(';')[0];
    const wid = decodeURIComponent(jar.split('=')[1]).slice(2).split('.')[0];
    await prisma.wishlistItem.createMany({
      data: ids
        .slice(1, 200)
        .map((productId) => ({ wishlistId: wid, productId })),
    });
    expect(
      await prisma.wishlistItem.count({ where: { wishlistId: wid } }),
    ).toBe(200);
    const res = await post(ids[200], jar).expect(409);
    expect((res.body as { errorCode: string }).errorCode).toBe('WISHLIST_FULL');
    await post(ids[5], jar).expect(200);
  });
});
