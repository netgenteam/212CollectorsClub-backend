import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
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

interface CheckoutBody {
  orderId: string;
  status: string;
  orderAccessToken: string;
  paymentInstructions: unknown;
  stripe: { sessionId: string; url: string } | null;
  totalUsd: number;
  lines: unknown[];
}
interface ErrBody {
  errorCode?: string;
  message?: string;
}
interface OrderBody {
  orderId: string;
  status: string;
  lines: unknown[];
  statusHistory: {
    fromStatus: string | null;
    toStatus: string;
    actorType: string;
  }[];
}
interface ListBody {
  data: OrderBody[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

const PASSWORD = 'correct-horse-battery-12-6';
const TAG = randomUUID().slice(0, 8);
const emailOf = (k: string) => `e2e-12-6-${TAG}-${k}@212collectorsclub.test`;
const ADMIN_USERNAME = `e2e-admin-12-6-${TAG}`;
const ADMIN_EMAIL = `${ADMIN_USERNAME}@212collectorsclub.test`;
const ADMIN_PASSWORD = 'correct-horse-battery-staple-12-6';
const PNG = Buffer.from('fake-png-bytes-for-story-12-6');

const body = (over: Record<string, unknown> = {}) => ({
  paymentRail: 'pago_movil',
  fulfillmentType: 'delivery',
  addressLine1: 'Av. Test 1',
  city: 'Caracas',
  state: 'Distrito Capital',
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
  ...over,
});

/**
 * Story 12.6 e2e (FR-45, AD-31, AD-16): account checkout, "mis pedidos",
 * admin <-> customer flows and the final cross-domain regression of Epic 12.
 * Only in this module the ThrottlerGuard is a pass-through (the per-IP login
 * budget would starve the many logins here); 12.3/12.6-resend e2e prove 429.
 */
describe(
  'Account checkout, my orders and cross e2e (Story 12.6)',
  { timeout: 30000 },
  () => {
    let app: NestExpressApplication;
    let prisma: PrismaService;
    let categoryId: string;
    let adminId: string;
    let adminToken: string;
    const productIds: string[] = [];
    const emails: string[] = [];
    const proofFiles: string[] = [];
    const server = () => app.getHttpServer();

    const mkProduct = async (key: string, stock: number): Promise<string> => {
      const p = await prisma.product.create({
        data: {
          name: `Chk${TAG} ${key}`,
          slug: `chk${TAG}-${key}`.toLowerCase(),
          description: 'Created by e2e 12.6.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '5.00',
          stock,
          heldQty: 0,
          isActive: true,
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

      const passwordHash = await argon2.hash(ADMIN_PASSWORD, {
        type: argon2.argon2id,
      });
      const admin = await prisma.adminUser.create({
        data: {
          username: ADMIN_USERNAME,
          email: ADMIN_EMAIL,
          passwordHash,
        },
      });
      adminId = admin.id;
      const res = await request(server())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
        .expect(200);
      adminToken = (res.body as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      await prisma.order.deleteMany({
        where: { lines: { some: { productId: { in: productIds } } } },
      });
      await prisma.cart.deleteMany({
        where: {
          OR: [
            { customer: { email: { in: emails } } },
            { items: { some: { productId: { in: productIds } } } },
          ],
        },
      });
      await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      await prisma.adminUser.delete({ where: { id: adminId } });
      for (const f of proofFiles) await unlink(f).catch(() => undefined);
      await app.close();
    });

    const cookieHeader = (res: request.Response, name: string): string =>
      ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0] as string;

    async function customer(
      k: string,
      verified = true,
    ): Promise<{ email: string; id: string; s: string }> {
      const email = emailOf(k);
      emails.push(email);
      await request(server())
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, name: 'Acc Tester' })
        .expect(201);
      const c = await prisma.customer.update({
        where: { email },
        data: { emailVerified: verified },
      });
      const res = await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return { email, id: c.id, s: cookieHeader(res, 'cc_session') };
    }

    const addToCart = (s: string, productId: string, quantity = 1) =>
      request(server())
        .post('/api/v1/cart/items')
        .set('Cookie', s)
        .send({ productId, quantity });
    const checkout = (s: string, over: Record<string, unknown> = {}) =>
      request(server())
        .post('/api/v1/checkout')
        .set('Cookie', s)
        .send(body(over));

    async function guestCheckout(
      productId: string,
      over: Record<string, unknown> = {},
    ): Promise<CheckoutBody> {
      const add = await request(server())
        .post('/api/v1/cart/items')
        .send({ productId, quantity: 1 })
        .expect(201);
      const res = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', cookieHeader(add, 'cartId'))
        .send(body(over))
        .expect(201);
      return res.body as CheckoutBody;
    }

    async function accountOrder(
      c: { s: string },
      productId: string,
      over: Record<string, unknown> = {},
    ): Promise<CheckoutBody> {
      await addToCart(c.s, productId).expect(201);
      const res = await checkout(c.s, over).expect(201);
      return res.body as CheckoutBody;
    }

    const admin = (method: 'get' | 'post', path: string) =>
      request(server())
        [method](path)
        .set('Authorization', `Bearer ${adminToken}`);
    const mine = (s: string, path = '') =>
      request(server()).get(`/api/v1/auth/orders${path}`).set('Cookie', s);
    const prod = (id: string) =>
      prisma.product.findUniqueOrThrow({ where: { id } });

    describe('AC1 schema', () => {
      it('Orders.customerId is a nullable uuid FK (SetNull) with the (customerId, createdAt) index', async () => {
        const cols = await prisma.$queryRaw<
          { data_type: string; is_nullable: string }[]
        >`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='Orders' AND column_name='customerId'`;
        expect(cols).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
        const fk = await prisma.$queryRaw<{ delete_rule: string }[]>`
          SELECT rc.delete_rule FROM information_schema.referential_constraints rc
          WHERE rc.constraint_name = 'Orders_customerId_fkey'`;
        expect(fk).toEqual([{ delete_rule: 'SET NULL' }]);
        const idx = await prisma.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes WHERE indexname='Orders_customerId_createdAt_idx'`;
        expect(idx[0].indexdef).toContain('("customerId", "createdAt")');
      });
    });

    describe('AC2/AC3/AC4/AC7 checkout', () => {
      it('verified customer pago movil: same response contract as guest, order linked, hold created, account cart cleared', async () => {
        const p = await mkProduct('c1', 10);
        const c = await customer('co1');
        const guest = await guestCheckout(p);
        const acct = await accountOrder(c, p);
        expect(Object.keys(acct).sort()).toEqual(Object.keys(guest).sort());
        expect(acct.status).toBe('pending_verification');
        expect(acct.paymentInstructions).not.toBeNull();
        expect(acct.orderAccessToken).toMatch(/^[0-9a-f]{64}$/);
        const [o, g] = await Promise.all([
          prisma.order.findUniqueOrThrow({ where: { id: acct.orderId } }),
          prisma.order.findUniqueOrThrow({ where: { id: guest.orderId } }),
        ]);
        expect(o.customerId).toBe(c.id);
        expect(g.customerId).toBeNull();
        expect(
          await prisma.stockHold.count({
            where: { orderId: o.id, releasedAt: null },
          }),
        ).toBe(1);
        expect((await prod(p)).heldQty).toBe(2);
        const cart = await request(server())
          .get('/api/v1/cart')
          .set('Cookie', c.s)
          .expect(200);
        expect((cart.body as { items: unknown[] }).items).toEqual([]);
      });

      it('verified customer stripe: same contract as a guest stripe checkout, linked to the account', async () => {
        const p = await mkProduct('st', 10);
        const c = await customer('st');
        const guest = await guestCheckout(p, { paymentRail: 'stripe' });
        const acct = await accountOrder(c, p, { paymentRail: 'stripe' });
        expect(Object.keys(acct).sort()).toEqual(Object.keys(guest).sort());
        expect(acct.stripe?.url).toBeTruthy();
        expect(acct.paymentInstructions).toBeNull();
        expect(acct.status).toBe('payment_processing');
        expect(
          (
            await prisma.order.findUniqueOrThrow({
              where: { id: acct.orderId },
            })
          ).customerId,
        ).toBe(c.id);
        const seen = await mine(c.s, `/${acct.orderId}`).expect(200);
        expect((seen.body as OrderBody).status).toBe('payment_processing');
      });

      it('unverified customer: 409 EMAIL_NOT_VERIFIED, no order, no hold, cart untouched', async () => {
        const p = await mkProduct('unv', 10);
        const c = await customer('unv', false);
        await addToCart(c.s, p).expect(201);
        const before = await prod(p);
        const res = await checkout(c.s).expect(409);
        expect((res.body as ErrBody).errorCode).toBe('EMAIL_NOT_VERIFIED');
        expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(
          0,
        );
        expect((await prod(p)).heldQty).toBe(before.heldQty);
        const cart = await request(server())
          .get('/api/v1/cart')
          .set('Cookie', c.s)
          .expect(200);
        expect((cart.body as { items: unknown[] }).items).toHaveLength(1);
        // once verified, the same cart checks out.
        await prisma.customer.update({
          where: { id: c.id },
          data: { emailVerified: true },
        });
        await checkout(c.s).expect(201);
      });

      it('no/invalid session behaves as guest; a logged-in checkout ignores a stale anonymous cartId cookie', async () => {
        const p = await mkProduct('g', 10);
        const guest = await guestCheckout(p);
        expect(
          (
            await prisma.order.findUniqueOrThrow({
              where: { id: guest.orderId },
            })
          ).customerId,
        ).toBeNull();
        // invalid session cookie + a real guest cart -> guest order
        const add = await request(server())
          .post('/api/v1/cart/items')
          .send({ productId: p, quantity: 1 })
          .expect(201);
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', [
            cookieHeader(add, 'cartId'),
            'cc_session=forged.value',
          ])
          .send(body())
          .expect(201);
        expect(
          (
            await prisma.order.findUniqueOrThrow({
              where: { id: (res.body as CheckoutBody).orderId },
            })
          ).customerId,
        ).toBeNull();
        // logged-in with empty account cart + stale guest cartId -> 422, guest cart intact
        const c = await customer('stale');
        const add2 = await request(server())
          .post('/api/v1/cart/items')
          .send({ productId: p, quantity: 1 })
          .expect(201);
        const anon = cookieHeader(add2, 'cartId');
        const r2 = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', [anon, c.s])
          .send(body())
          .expect(422);
        expect((r2.body as ErrBody).errorCode).toBe('EMPTY_CART');
        await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', anon)
          .send(body())
          .expect(201);
      });

      it('AC7: token flows (lookup, history, proof upload) work for an account order and a guest order', async () => {
        const p = await mkProduct('tok', 10);
        const c = await customer('tok');
        const acct = await accountOrder(c, p);
        const guest = await guestCheckout(p);
        for (const o of [acct, guest]) {
          const auth = `Bearer ${o.orderAccessToken}`;
          const r = await request(server())
            .get(`/api/v1/orders/${o.orderId}`)
            .set('Authorization', auth)
            .expect(200);
          expect((r.body as OrderBody).orderId).toBe(o.orderId);
          await request(server())
            .get(`/api/v1/orders/${o.orderId}/history`)
            .set('Authorization', auth)
            .expect(200);
          await request(server())
            .post(`/api/v1/orders/${o.orderId}/proof-of-payment`)
            .set('Authorization', auth)
            .attach('file', PNG, {
              filename: 'p.png',
              contentType: 'image/png',
            })
            .expect(201);
          const proofs = await prisma.proofOfPayment.findMany({
            where: { orderId: o.orderId },
          });
          for (const pr of proofs) {
            proofFiles.push(
              join(process.cwd(), 'uploads', 'private', pr.filePath),
            );
          }
        }
        // the session cookie is NOT a substitute for the order token
        await request(server())
          .get(`/api/v1/orders/${acct.orderId}`)
          .set('Cookie', c.s)
          .expect(401);
      });
    });

    describe('AC5/AC6 my orders', () => {
      it('lists only the caller orders, newest first, paginated like the catalog; 401 without session', async () => {
        const p = await mkProduct('list', 20);
        const a = await customer('la');
        const b = await customer('lb');
        const ids: string[] = [];
        for (let i = 0; i < 3; i++)
          ids.push((await accountOrder(a, p)).orderId);
        const other = await accountOrder(b, p);
        await guestCheckout(p);

        const all = (await mine(a.s).expect(200)).body as ListBody;
        expect(all.data.map((o) => o.orderId)).toEqual([...ids].reverse());
        expect(all.meta).toEqual({
          page: 1,
          limit: 20,
          total: 3,
          totalPages: 1,
        });
        expect(all.data.map((o) => o.orderId)).not.toContain(other.orderId);

        const p2 = (await mine(a.s, '?page=2&limit=2').expect(200))
          .body as ListBody;
        expect(p2.data.map((o) => o.orderId)).toEqual([ids[0]]);
        expect(p2.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
        const empty = (await mine(a.s, '?page=9').expect(200)).body as ListBody;
        expect(empty.data).toEqual([]);

        await mine(a.s, '?limit=0').expect(400);
        await mine(a.s, '?page=abc').expect(400);
        const none = await request(server())
          .get('/api/v1/auth/orders')
          .expect(401);
        expect((none.body as ErrBody).errorCode).toBe('INVALID_CUSTOMER_TOKEN');
      });

      it('detail: own order 200 with history; foreign / guest / unknown give the SAME 404; non-UUID 400', async () => {
        const p = await mkProduct('det', 10);
        const a = await customer('da');
        const b = await customer('db');
        const own = await accountOrder(a, p);
        const guest = await guestCheckout(p);
        const res = await mine(a.s, `/${own.orderId}`).expect(200);
        const d = res.body as OrderBody;
        expect(d.orderId).toBe(own.orderId);
        expect(d.lines).toHaveLength(1);
        expect(d.statusHistory).toEqual([
          expect.objectContaining({
            fromStatus: null,
            toStatus: 'pending_verification',
            actorType: 'system',
          }),
        ]);
        const bodies: unknown[] = [];
        for (const id of [own.orderId, guest.orderId, randomUUID()]) {
          const r = await mine(b.s, `/${id}`).expect(404);
          bodies.push(r.body);
        }
        const unknown = await mine(a.s, `/${randomUUID()}`).expect(404);
        const guestSeen = await mine(a.s, `/${guest.orderId}`).expect(404);
        expect(unknown.body).toEqual(guestSeen.body);
        expect(bodies[0]).toEqual(bodies[1]);
        expect(bodies[1]).toEqual(bodies[2]);
        await mine(a.s, '/not-a-uuid').expect(400);
        await request(server())
          .get(`/api/v1/auth/orders/${own.orderId}`)
          .expect(401);
      });
    });

    describe('AC8 admin -> customer', () => {
      it('confirm -> paid -> fulfilled, and reject, are visible in my orders with history', async () => {
        const p = await mkProduct('adm', 20);
        const c = await customer('adm');
        const o1 = await accountOrder(c, p);
        const o2 = await accountOrder(c, p);

        await admin(
          'post',
          `/api/v1/admin/orders/${o1.orderId}/confirm-payment`,
        ).expect(200);
        let seen = (await mine(c.s, `/${o1.orderId}`).expect(200))
          .body as OrderBody;
        expect(seen.status).toBe('paid');
        expect(seen.statusHistory.map((h) => h.toStatus)).toEqual([
          'pending_verification',
          'paid',
        ]);
        expect(seen.statusHistory[1].actorType).toBe('admin');

        await admin(
          'post',
          `/api/v1/admin/orders/${o1.orderId}/fulfill`,
        ).expect(200);
        seen = (await mine(c.s, `/${o1.orderId}`).expect(200))
          .body as OrderBody;
        expect(seen.status).toBe('fulfilled');

        await admin(
          'post',
          `/api/v1/admin/orders/${o2.orderId}/reject-payment`,
        ).expect(200);
        seen = (await mine(c.s, `/${o2.orderId}`).expect(200))
          .body as OrderBody;
        expect(seen.status).toBe('payment_rejected');
        // rejecting released the hold; confirming consumed stock once.
        const after = await prod(p);
        expect(after.heldQty).toBe(0);
        expect(after.stock).toBe(19);
      });
    });

    describe('AC9 cross auth domains', () => {
      it('customer cookie vs admin routes, admin Bearer vs customer routes, admin list shows the order, A cannot read B', async () => {
        const p = await mkProduct('x', 10);
        const a = await customer('xa');
        const b = await customer('xb');
        const ao = await accountOrder(a, p);
        const bo = await accountOrder(b, p);

        for (const [m, path] of [
          ['get', '/api/v1/admin/orders'],
          ['post', `/api/v1/admin/orders/${ao.orderId}/confirm-payment`],
          ['post', `/api/v1/admin/orders/${ao.orderId}/fulfill`],
        ] as const) {
          const r = await request(server())
            [m](path)
            .set('Cookie', a.s)
            .expect(401);
          expect((r.body as ErrBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
        }
        expect(
          (await prisma.order.findUniqueOrThrow({ where: { id: ao.orderId } }))
            .status,
        ).toBe('PENDING_VERIFICATION');

        for (const path of [
          '/api/v1/auth/orders',
          `/api/v1/auth/orders/${ao.orderId}`,
          '/api/v1/auth/me',
        ]) {
          const r = await admin('get', path).expect(401);
          expect((r.body as ErrBody).errorCode).toBe('INVALID_CUSTOMER_TOKEN');
        }

        const list = (
          await admin('get', '/api/v1/admin/orders?limit=100').expect(200)
        ).body as { data: { orderId: string }[] };
        const seen = list.data.map((o) => o.orderId);
        expect(seen).toContain(ao.orderId);
        expect(seen).toContain(bo.orderId);

        await mine(a.s, `/${bo.orderId}`).expect(404);
        await mine(b.s, `/${ao.orderId}`).expect(404);
        // an order token is not a customer credential either
        await request(server())
          .get('/api/v1/auth/orders')
          .set('Authorization', `Bearer ${ao.orderAccessToken}`)
          .expect(401);
      });
    });

    describe('AC10 concurrency on the last unit (AD-16)', () => {
      it('same customer, two simultaneous checkouts of the last unit: exactly one order, no oversell', async () => {
        for (let round = 0; round < 4; round++) {
          const p = await mkProduct(`last${round}`, 1);
          const c = await customer(`last${round}`);
          await addToCart(c.s, p).expect(201);
          const rs = await Promise.all([checkout(c.s), checkout(c.s)]);
          const statuses = rs.map((r) => r.status).sort();
          expect(statuses[0]).toBe(201);
          expect([409, 422]).toContain(statuses[1]);
          expect(statuses.filter((s) => s === 201)).toHaveLength(1);
          const failed = rs.find((r) => r.status !== 201) as request.Response;
          expect(['INSUFFICIENT_STOCK', 'EMPTY_CART']).toContain(
            (failed.body as ErrBody).errorCode,
          );
          expect(
            await prisma.order.count({ where: { customerId: c.id } }),
          ).toBe(1);
          const after = await prod(p);
          expect(after.heldQty).toBe(1);
          expect(after.stock).toBe(1);
        }
      });

      it('two customers (and a guest) racing for the last unit: exactly one succeeds, the rest get INSUFFICIENT_STOCK', async () => {
        for (let round = 0; round < 4; round++) {
          const p = await mkProduct(`race${round}`, 1);
          const a = await customer(`ra${round}`);
          const b = await customer(`rb${round}`);
          await addToCart(a.s, p).expect(201);
          await addToCart(b.s, p).expect(201);
          const g = await request(server())
            .post('/api/v1/cart/items')
            .send({ productId: p, quantity: 1 })
            .expect(201);
          const rs = await Promise.all([
            checkout(a.s),
            checkout(b.s),
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', cookieHeader(g, 'cartId'))
              .send(body()),
          ]);
          expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
          for (const r of rs.filter((x) => x.status !== 201)) {
            expect(r.status).toBe(409);
            expect((r.body as ErrBody).errorCode).toBe('INSUFFICIENT_STOCK');
          }
          expect((await prod(p)).heldQty).toBe(1);
        }
      });
    });
  },
);
