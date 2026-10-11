import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface CartBody {
  items: { productId: string; quantity: number }[];
  total: number;
}
interface WishBody {
  productIds: string[];
}

const PASSWORD = 'correct-horse-battery-12-5';
const TAG = randomUUID().slice(0, 8);
const emailOf = (k: string) => `e2e-12-5-${TAG}-${k}@212collectorsclub.test`;

/**
 * Story 12.5 e2e (FR-44, AD-29): account-bound cart/wishlist and merge on
 * login. The per-IP login throttle (5/10min) would starve the concurrency
 * cases, so ONLY in this test module the ThrottlerGuard is replaced by a
 * pass-through; production wiring is untouched (12.3's own e2e still proves
 * the 429).
 */
describe('Account cart and wishlist with login merge (e2e, Story 12.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let categoryId: string;
  const productIds: string[] = [];
  const emails: string[] = [];
  let p1: string; // stock 10
  let p2: string; // stock 10
  let p3: string; // stock 3
  let pInactive: string;
  let pOut: string; // stock 0

  const server = () => app.getHttpServer();

  const mk = async (
    key: string,
    stock: number,
    isActive = true,
  ): Promise<string> => {
    const p = await prisma.product.create({
      data: {
        name: `Acc${TAG} ${key}`,
        slug: `acc${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 12.5.',
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
    await app.init();
    prisma = app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    p1 = await mk('p1', 10);
    p2 = await mk('p2', 10);
    p3 = await mk('p3', 3);
    pInactive = await mk('inactive', 10);
    pOut = await mk('out', 10);
  });

  afterAll(async () => {
    await prisma.cart.deleteMany({
      where: { customer: { email: { in: emails } } },
    });
    await prisma.wishlist.deleteMany({
      where: { customer: { email: { in: emails } } },
    });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await prisma.cart.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.wishlist.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await app.close();
  });

  const cookiesOf = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const pair = (res: request.Response, name: string): string | undefined =>
    cookiesOf(res)
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0];
  const isCleared = (res: request.Response, name: string): boolean =>
    cookiesOf(res).some(
      (c) => c.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/.test(c),
    );

  async function newCustomer(k: string): Promise<string> {
    const email = emailOf(k);
    emails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Acc Tester' })
      .expect(201);
    return email;
  }
  const login = (email: string, cookie?: string, password = PASSWORD) => {
    const r = request(server())
      .post('/api/v1/auth/login')
      .send({ email, password });
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const session = (res: request.Response) => pair(res, 'cc_session') as string;

  async function loggedIn(k: string): Promise<{ email: string; s: string }> {
    const email = await newCustomer(k);
    const res = await login(email).expect(200);
    return { email, s: session(res) };
  }

  const addCart = (productId: string, quantity: number, cookie?: string) => {
    const r = request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity });
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const getCart = (cookie?: string) => {
    const r = request(server()).get('/api/v1/cart');
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const addWish = (productId: string, cookie?: string) => {
    const r = request(server())
      .post('/api/v1/wishlist/items')
      .send({ productId });
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const getWish = (cookie?: string) => {
    const r = request(server()).get('/api/v1/wishlist');
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const qty = (b: CartBody, id: string) =>
    b.items.find((i) => i.productId === id)?.quantity;
  const setStock = (id: string, stock: number, heldQty = 0) =>
    prisma.product.update({ where: { id }, data: { stock, heldQty } });

  describe('AC1: schema', () => {
    it('Cart/Wishlist.customerId are nullable unique uuid FKs with SET NULL', async () => {
      const rows = await prisma.$queryRaw<
        { table_name: string; is_nullable: string; data_type: string }[]
      >`SELECT table_name, is_nullable, data_type FROM information_schema.columns
        WHERE column_name = 'customerId' AND table_name IN ('Carts','Wishlists')`;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.is_nullable).toBe('YES');
        expect(r.data_type).toBe('uuid');
      }
      const fks = await prisma.$queryRaw<{ delete_rule: string }[]>`
        SELECT rc.delete_rule FROM information_schema.referential_constraints rc
        WHERE rc.constraint_name IN ('Carts_customerId_fkey','Wishlists_customerId_fkey')`;
      expect(fks.map((f) => f.delete_rule)).toEqual(['SET NULL', 'SET NULL']);
      const idx = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN ('Carts_customerId_key','Wishlists_customerId_key')`;
      expect(idx).toHaveLength(2);
    });
  });

  describe('AC2/AC3: account owner vs guest', () => {
    it('logged-in cart is per account, shared across sessions, no cartId cookie', async () => {
      const { email, s } = await loggedIn('own');
      const add = await addCart(p1, 2, s).expect(201);
      expect(pair(add, 'cartId')).toBeUndefined();
      expect((add.body as CartBody).items).toHaveLength(1);
      await addCart(p1, 1, s).expect(201);

      const second = await login(email).expect(200);
      const seen = await getCart(session(second)).expect(200);
      expect(qty(seen.body as CartBody, p1)).toBe(3);

      await request(server())
        .patch(`/api/v1/cart/items/${p1}`)
        .set('Cookie', s)
        .send({ quantity: 5 })
        .expect(200);
      await request(server())
        .patch(`/api/v1/cart/items/${p1}`)
        .set('Cookie', s)
        .send({ quantity: 11 })
        .expect(409);
      const del = await request(server())
        .delete(`/api/v1/cart/items/${p1}`)
        .set('Cookie', s)
        .expect(200);
      expect((del.body as CartBody).items).toEqual([]);
      await request(server())
        .delete(`/api/v1/cart/items/${p1}`)
        .set('Cookie', s)
        .expect(404);
      await addCart(p3, 4, s).expect(409);
    });

    it('logged-in wishlist is per account and shared across sessions', async () => {
      const { email, s } = await loggedIn('wown');
      const add = await addWish(p1, s).expect(200);
      expect(pair(add, 'wishlistId')).toBeUndefined();
      await addWish(p1, s).expect(200);
      await addWish(p2, s).expect(200);
      const second = await login(email).expect(200);
      const seen = await getWish(session(second)).expect(200);
      expect((seen.body as WishBody).productIds).toHaveLength(2);
      await request(server())
        .delete(`/api/v1/wishlist/items/${p1}`)
        .set('Cookie', s)
        .expect(204);
      const after = await getWish(s).expect(200);
      expect((after.body as WishBody).productIds).toEqual([p2]);
    });

    it('invalid or revoked session behaves exactly like a guest', async () => {
      const res = await addCart(p1, 1, 'cc_session=garbage').expect(201);
      expect(pair(res, 'cartId')).toBeDefined();
      const { s } = await loggedIn('revoked');
      await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', s)
        .expect(204);
      const after = await getCart(s).expect(200);
      expect(after.body).toEqual({ items: [], total: 0 });
      const guest = await addWish(p1, s).expect(200);
      expect(pair(guest, 'wishlistId')).toBeDefined();
    });
  });

  describe('AC4/AC5/AC8: cart merge on login', () => {
    it('assigns the anonymous cart when the account has none, clears the cookie', async () => {
      const email = await newCustomer('assign');
      const anon = pair(await addCart(p1, 2), 'cartId') as string;
      const anonId = (
        await prisma.cart.findFirstOrThrow({
          where: { items: { some: { productId: p1 } }, customerId: null },
          orderBy: { createdAt: 'desc' },
        })
      ).id;
      const res = await login(email, anon).expect(200);
      expect(isCleared(res, 'cartId')).toBe(true);
      const cart = await getCart(session(res)).expect(200);
      expect(qty(cart.body as CartBody, p1)).toBe(2);
      const owned = await prisma.cart.findFirstOrThrow({
        where: { customer: { email } },
      });
      expect(owned.id).toBe(anonId);
      // the old anonymous cookie no longer resolves to a guest cart
      expect((await getCart(anon).expect(200)).body).toEqual({
        items: [],
        total: 0,
      });
    });

    it('sums overlapping products capped at stock - heldQty, drops inactive/out-of-stock, deletes the anonymous cart', async () => {
      const { email, s } = await loggedIn('merge');
      await addCart(p3, 2, s).expect(201);
      await addCart(p2, 3, s).expect(201);

      const a = await addCart(p3, 2); // anon p3=2
      const anon = pair(a, 'cartId') as string;
      await addCart(p2, 4, anon).expect(201);
      await addCart(pInactive, 2, anon).expect(201);
      await addCart(pOut, 2, anon).expect(201);
      await prisma.product.update({
        where: { id: pInactive },
        data: { isActive: false },
      });
      await setStock(pOut, 0);
      await setStock(p2, 10, 5); // available 5 -> 3 + 4 trimmed to 5

      const anonCart = await prisma.cart.findFirstOrThrow({
        where: { items: { some: { productId: pInactive } } },
      });
      const res = await login(email, anon).expect(200);
      await setStock(p2, 10, 0);
      await prisma.product.update({
        where: { id: pInactive },
        data: { isActive: true },
      });
      await setStock(pOut, 10);

      expect(isCleared(res, 'cartId')).toBe(true);
      const cart = (await getCart(session(res)).expect(200)).body as CartBody;
      expect(qty(cart, p3)).toBe(3); // 2 + 2 capped at stock 3
      expect(qty(cart, p2)).toBe(5); // 3 + 4 capped at available 5
      expect(qty(cart, pInactive)).toBeUndefined();
      expect(qty(cart, pOut)).toBeUndefined();
      expect(await prisma.cart.count({ where: { id: anonCart.id } })).toBe(0);
      const prod = await prisma.product.findUniqueOrThrow({
        where: { id: p3 },
      });
      expect(prod.heldQty).toBe(0);
      expect(prod.stock).toBe(3);
    });
  });

  describe('AC6: wishlist merge on login', () => {
    it('unions without duplicates, deletes the anonymous wishlist, clears the cookie', async () => {
      const { email, s } = await loggedIn('wmerge');
      await addWish(p1, s).expect(200);
      await addWish(p2, s).expect(200);
      const w = await addWish(p2);
      const anon = pair(w, 'wishlistId') as string;
      await addWish(p3, anon).expect(200);
      await addWish(p1, anon).expect(200);
      const anonRow = await prisma.wishlist.findFirstOrThrow({
        where: { customerId: null, items: { some: { productId: p3 } } },
      });
      const res = await login(email, anon).expect(200);
      expect(isCleared(res, 'wishlistId')).toBe(true);
      const list = (await getWish(session(res)).expect(200)).body as WishBody;
      expect([...list.productIds].sort()).toEqual([p1, p2, p3].sort());
      expect(await prisma.wishlist.count({ where: { id: anonRow.id } })).toBe(
        0,
      );
    });

    it('respects the 200 cap by trimming and never fails the login', async () => {
      const { email, s } = await loggedIn('wcap');
      const acct = await prisma.wishlist
        .findFirstOrThrow({
          where: { customer: { email } },
        })
        .catch(async () => {
          await addWish(p1, s).expect(200);
          return prisma.wishlist.findFirstOrThrow({
            where: { customer: { email } },
          });
        });
      // 199 existing items (filler products) + p1 already there
      const filler: string[] = [];
      for (let i = 0; i < 198; i += 1) {
        filler.push(await mk(`f${i}`, 1));
      }
      await prisma.wishlistItem.createMany({
        data: filler.map((productId) => ({ wishlistId: acct.id, productId })),
      });
      expect(
        await prisma.wishlistItem.count({ where: { wishlistId: acct.id } }),
      ).toBe(199);
      const anon = pair(await addWish(p2), 'wishlistId') as string;
      await addWish(p3, anon).expect(200);
      const res = await login(email, anon).expect(200);
      expect(
        await prisma.wishlistItem.count({ where: { wishlistId: acct.id } }),
      ).toBe(200);
      expect(isCleared(res, 'wishlistId')).toBe(true);
    }, 60_000);
  });

  describe('AC9: failed login', () => {
    it('leaves the anonymous cart, wishlist and cookies untouched', async () => {
      const email = await newCustomer('fail');
      const c = pair(await addCart(p1, 1), 'cartId') as string;
      const w = pair(await addWish(p1), 'wishlistId') as string;
      const res = await login(email, `${c}; ${w}`, 'wrong-password-xx').expect(
        401,
      );
      expect(
        cookiesOf(res).filter((x) => /^(cartId|wishlistId)=/.test(x)),
      ).toEqual([]);
      expect(qty((await getCart(c)).body as CartBody, p1)).toBe(1);
      expect((await getWish(w)).body).toMatchObject({ productIds: [p1] });
    });
  });

  describe('logout', () => {
    it('after logout the cart is a fresh empty anonymous one; the account cart persists', async () => {
      const { email, s } = await loggedIn('logout');
      await addCart(p1, 2, s).expect(201);
      await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', s)
        .expect(204);
      expect((await getCart().expect(200)).body).toEqual({
        items: [],
        total: 0,
      });
      const again = await login(email).expect(200);
      expect(qty((await getCart(session(again))).body as CartBody, p1)).toBe(2);
    });
  });

  describe('AC7: concurrency', () => {
    it('two simultaneous logins with the same anonymous cookies merge exactly once (account has a cart)', async () => {
      const { email, s } = await loggedIn('conc');
      await addCart(p2, 3, s).expect(201);
      await addWish(p1, s).expect(200);
      const anon = pair(await addCart(p2, 2), 'cartId') as string;
      const w = pair(await addWish(p3), 'wishlistId') as string;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => login(email, `${anon}; ${w}`)),
      );
      expect(results.map((r) => r.status)).toEqual([
        200, 200, 200, 200, 200, 200,
      ]);
      const cart = (await getCart(s)).body as CartBody;
      expect(qty(cart, p2)).toBe(5); // 3 + 2 once, not doubled
      const wl = (await getWish(s)).body as WishBody;
      expect([...wl.productIds].sort()).toEqual([p1, p3].sort());
      expect(await prisma.cart.count({ where: { customer: { email } } })).toBe(
        1,
      );
    });

    it('simultaneous logins when the account has no cart yet assign it once', async () => {
      const email = await newCustomer('conc2');
      const anon = pair(await addCart(p2, 2), 'cartId') as string;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => login(email, anon)),
      );
      expect(results.map((r) => r.status)).toEqual([
        200, 200, 200, 200, 200, 200,
      ]);
      const s = session(results[0]);
      expect(qty((await getCart(s)).body as CartBody, p2)).toBe(2);
    });

    it('login racing account addItem never 500s, never duplicates or oversells', async () => {
      const { email, s } = await loggedIn('conc3');
      const anon = pair(await addCart(p2, 2), 'cartId') as string;
      const [l1, l2, a1, a2, a3] = await Promise.all([
        login(email, anon),
        login(email, anon),
        addCart(p2, 1, s),
        addCart(p2, 1, s),
        addCart(p1, 1, s),
      ]);
      expect([l1.status, l2.status]).toEqual([200, 200]);
      for (const r of [a1, a2, a3]) expect(r.status).toBe(201);
      const cart = (await getCart(s)).body as CartBody;
      expect(qty(cart, p2)).toBe(4);
      expect(qty(cart, p1)).toBeGreaterThanOrEqual(1);
      expect(await prisma.cart.count({ where: { customer: { email } } })).toBe(
        1,
      );
    });

    it('anonymous addItem racing a login with the same cookie never 500s', async () => {
      const email = await newCustomer('conc4');
      const anon = pair(await addCart(p1, 1), 'cartId') as string;
      const calls = [
        login(email, anon),
        addCart(p1, 1, anon),
        addCart(p2, 1, anon),
        login(email, anon),
      ];
      const res = await Promise.all(calls);
      for (const r of res) expect(r.status).toBeLessThan(400);
    });

    it('concurrent account addItem never oversells the last units', async () => {
      const { s } = await loggedIn('conc5');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => addCart(p3, 1, s)),
      );
      const ok = results.filter((r) => r.status === 201).length;
      const conflict = results.filter((r) => r.status === 409).length;
      expect(ok).toBe(3);
      expect(conflict).toBe(5);
      expect(qty((await getCart(s)).body as CartBody, p3)).toBe(3);
    });
  });
});
