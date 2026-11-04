/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { CartService } from './../src/cart/cart.service.js';
import { WishlistService } from './../src/wishlist/wishlist.service.js';
import { AdminCustomersService } from './../src/admin-customers/admin-customers.service.js';
import {
  BASE,
  bootHarness,
  type Cust,
  type Harness,
} from './helpers/account-write-race.js';

/**
 * Story 20.6 (D1): EVERY write to the data of an account serializes with the anonymization and is
 * refused (401) when the account is already anonymized. One deterministic test per route:
 *
 *   1. a second connection holds `FOR UPDATE` on a row of `Customer_Addresses` of the account;
 *   2. `POST /admin/customers/:id/anonymize` takes the `FOR UPDATE` of the Customers row and BLOCKS
 *      deleting the addresses (polled in pg_stat_activity, not slept);
 *   3. the request of the account arrives with its cookie (its session was read before the commit)
 *      and BLOCKS on the Customers row lock (polled too);
 *   4. the holder commits: the anonymization answers 200 and the request in flight 401, and the
 *      account keeps NOTHING of the person (name, phone, address, cart, wishlist).
 *
 * Mutation proof (see docs/deployment.md 18.6): with `lockLiveCustomer` not checking `anonymizedAt`
 * the tests of the routes below fail with 200/201 and leftovers. Guests are checked too: a guest
 * cart/wishlist write is never blocked and a guest cart is never touched by an account's merge.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const LOCK_STMT = '%"Customers"%FOR%';
const ADDR_DELETE = '%Customer_Addresses%';

type Ctx = { c: Cust; pid: string; h: Harness };
interface Route {
  name: string;
  /** Prepares rows BEFORE the race (e.g. an existing cart line to PATCH). */
  setup?: (x: Ctx) => Promise<void>;
  call: (x: Ctx) => request.Test;
}

describe(
  'Account writes vs anonymization (e2e, Story 20.6 D1)',
  { timeout: 120_000 },
  () => {
    let h: Harness;
    const server = () => h.server();
    const jar = (x: Ctx) => ({ Cookie: x.c.cookie });

    beforeAll(async () => {
      h = await bootHarness(TAG);
    });
    afterAll(async () => {
      await h.close();
    });

    const routes: Route[] = [
      {
        name: 'PATCH /auth/me (name, phone)',
        call: (x) =>
          server()
            .patch(`${BASE}/auth/me`)
            .set(jar(x))
            .send({ name: 'Nombre Real Nuevo', phone: '04149998877' }),
      },
      {
        name: 'POST /auth/addresses',
        call: (x) =>
          server().post(`${BASE}/auth/addresses`).set(jar(x)).send({
            agencyId: x.h.agencyId,
            deliveryMode: 'home_delivery',
            recipientName: 'Maria Perez',
            recipientPhone: '+58 (412) 123-4567',
            recipientIdDoc: 'v91234567',
            state: 'Miranda',
            municipality: 'Baruta',
            addressLine1: 'Calle 1, Casa 2',
          }),
      },
      {
        name: 'PATCH /auth/addresses/:id',
        call: (x) =>
          server()
            .patch(`${BASE}/auth/addresses/${x.c.addrId}`)
            .set(jar(x))
            .send({ label: 'Casa' }),
      },
      {
        name: 'PATCH /auth/addresses/:id/set-default',
        call: (x) =>
          server()
            .patch(`${BASE}/auth/addresses/${x.c.addrId}/set-default`)
            .set(jar(x)),
      },
      {
        name: 'DELETE /auth/addresses/:id',
        call: (x) =>
          server().delete(`${BASE}/auth/addresses/${x.c.addrId}`).set(jar(x)),
      },
      {
        name: 'POST /cart/items (account)',
        call: (x) =>
          server()
            .post(`${BASE}/cart/items`)
            .set(jar(x))
            .send({ productId: x.pid, quantity: 1 }),
      },
      {
        name: 'PATCH /cart/items/:productId (account)',
        setup: async (x) => {
          await x.h.prisma.cart.create({
            data: {
              customerId: x.c.id,
              expiresAt: new Date(Date.now() + 86_400_000),
              items: { create: [{ productId: x.pid, quantity: 1 }] },
            },
          });
        },
        call: (x) =>
          server()
            .patch(`${BASE}/cart/items/${x.pid}`)
            .set(jar(x))
            .send({ quantity: 2 }),
      },
      {
        name: 'DELETE /cart/items/:productId (account)',
        setup: async (x) => {
          await x.h.prisma.cart.create({
            data: {
              customerId: x.c.id,
              expiresAt: new Date(Date.now() + 86_400_000),
              items: { create: [{ productId: x.pid, quantity: 1 }] },
            },
          });
        },
        call: (x) => server().delete(`${BASE}/cart/items/${x.pid}`).set(jar(x)),
      },
      {
        name: 'POST /wishlist/items (account)',
        call: (x) =>
          server()
            .post(`${BASE}/wishlist/items`)
            .set(jar(x))
            .send({ productId: x.pid }),
      },
      {
        name: 'DELETE /wishlist/items/:productId (account)',
        setup: async (x) => {
          await x.h.prisma.wishlist.create({
            data: {
              customerId: x.c.id,
              expiresAt: new Date(Date.now() + 86_400_000),
              items: { create: [{ productId: x.pid }] },
            },
          });
        },
        call: (x) =>
          server().delete(`${BASE}/wishlist/items/${x.pid}`).set(jar(x)),
      },
      {
        name: 'POST /me/consent (re-acceptance)',
        call: (x) => server().post(`${BASE}/me/consent`).set(jar(x)).send({}),
      },
    ];

    it.each(routes)(
      '$name: serializes with the anonymization, 401 afterwards and nothing of the person survives',
      async (route) => {
        const c = await h.mkCustomer('r');
        const x: Ctx = { c, pid: await h.mkProduct(), h };
        await route.setup?.(x);
        const holder = await h.holdAddress(c.addrId);
        try {
          const anon = h.anonymize(c.id, c.email);
          await h.waitBlocked(ADDR_DELETE);
          const inFlight = route.call(x).then((r) => r);
          await h.waitBlocked(LOCK_STMT);
          await holder.release();
          const [a, r] = await Promise.all([anon, inFlight]);
          expect(a.status, JSON.stringify(a.body)).toBe(200);
          expect(a.body.alreadyAnonymized).toBe(false);
          expect(r.status, JSON.stringify(r.body)).toBe(401);
          expect(r.body.errorCode).toBe('INVALID_CUSTOMER_TOKEN');
        } finally {
          await holder.abort();
        }
        expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
      },
    );

    it('the lock is the SAME one the checkout takes: a request that wins it first is deleted by the anonymization', async () => {
      // positive control: the request starts while nobody holds anything -> 200, then anonymize wipes it
      const c = await h.mkCustomer('first');
      const ok = await server()
        .patch(`${BASE}/auth/me`)
        .set({ Cookie: c.cookie })
        .send({ name: 'Nombre Real', phone: '04140000000' })
        .expect(200);
      expect(ok.body.name).toBe('Nombre Real');
      const a = await h.anonymize(c.id, c.email);
      expect(a.status).toBe(200);
      expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
    });

    it("login merge: the anonymous cart and wishlist are NOT claimed by an anonymized account (they stay the guest's)", async () => {
      const c = await h.mkCustomer('merge');
      const pid = await h.mkProduct();
      const guestCart = await h.mkGuestCart(pid);
      const guestWish = await h.mkGuestWishlist(pid);
      const carts = h.app.get(CartService);
      const wishlists = h.app.get(WishlistService);
      const holder = await h.holdAddress(c.addrId);
      try {
        const anon = h.anonymize(c.id, c.email);
        await h.waitBlocked(ADDR_DELETE);
        const m1 = carts.mergeAnonymousCart(c.id, guestCart).then(
          () => 'merged',
          (e: { getStatus?: () => number }) => e.getStatus?.() ?? 'error',
        );
        const m2 = wishlists.mergeAnonymousWishlist(c.id, guestWish).then(
          () => 'merged',
          (e: { getStatus?: () => number }) => e.getStatus?.() ?? 'error',
        );
        await h.waitBlocked(LOCK_STMT);
        await holder.release();
        expect((await anon).status).toBe(200);
        expect(await m1).toBe(401);
        expect(await m2).toBe(401);
      } finally {
        await holder.abort();
      }
      const cart = await h.prisma.cart.findUniqueOrThrow({
        where: { id: guestCart },
        include: { items: true },
      });
      expect(cart.customerId).toBeNull();
      expect(cart.items).toHaveLength(1);
      const wl = await h.prisma.wishlist.findUniqueOrThrow({
        where: { id: guestWish },
        include: { items: true },
      });
      expect(wl.customerId).toBeNull();
      expect(wl.items).toHaveLength(1);
      expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
    });

    it('guests are NOT affected: their cart / wishlist writes are never blocked by an anonymization in progress', async () => {
      const c = await h.mkCustomer('guests');
      const pid = await h.mkProduct();
      const holder = await h.holdAddress(c.addrId);
      try {
        const anon = h.anonymize(c.id, c.email);
        await h.waitBlocked(ADDR_DELETE);
        const t0 = Date.now();
        const gc = await server()
          .post(`${BASE}/cart/items`)
          .send({ productId: pid, quantity: 1 });
        const gw = await server()
          .post(`${BASE}/wishlist/items`)
          .send({ productId: pid });
        expect(gc.status).toBe(201);
        expect(gw.status).toBe(200);
        // answered while the anonymization is still blocked
        expect(Date.now() - t0).toBeLessThan(2_000);
        await h.waitBlocked(ADDR_DELETE);
        await holder.release();
        expect((await anon).status).toBe(200);
        const cartId = (gc.body as { cartId?: string }).cartId;
        if (cartId) {
          expect(
            await h.prisma.cart.count({
              where: { id: cartId, customerId: null },
            }),
          ).toBe(1);
        }
      } finally {
        await holder.abort();
      }
      // clean the guest rows this test made
      const items = await h.prisma.cartItem.findMany({
        where: { productId: pid },
      });
      await h.prisma.cart.deleteMany({
        where: { id: { in: items.map((i) => i.cartId) }, customerId: null },
      });
      const wls = await h.prisma.wishlistItem.findMany({
        where: { productId: pid },
      });
      await h.prisma.wishlist.deleteMany({
        where: { id: { in: wls.map((i) => i.wishlistId) }, customerId: null },
      });
    });

    it('resend-verification: the token created in the background is not left behind on an anonymized account', async () => {
      const c = await h.mkCustomer('resend', { verified: false });
      // the register mail token is issued in the background
      await new Promise((r) => setTimeout(r, 400));
      const holder = await h.holdAddress(c.addrId);
      try {
        const anon = h.anonymize(c.id, c.email);
        await h.waitBlocked(ADDR_DELETE);
        await server()
          .post(`${BASE}/auth/resend-verification`)
          .send({ email: c.email })
          .expect(200);
        await h.waitBlocked(LOCK_STMT);
        await holder.release();
        expect((await anon).status).toBe(200);
      } finally {
        await holder.abort();
      }
      await new Promise((r) => setTimeout(r, 600));
      expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
    });

    it('admin verify-email: serializes with the anonymization, then 404 (no effect, no event); the placeholder address is 404 too', async () => {
      const prev = process.env.MANUAL_EMAIL_VERIFY_ENABLED;
      process.env.MANUAL_EMAIL_VERIFY_ENABLED = 'true';
      try {
        const c = await h.mkCustomer('adminv', { verified: false });
        const svc = h.app.get(AdminCustomersService);
        const events = async () =>
          Number(
            (
              await h.sql(
                `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action" = 'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN' AND "entityId" = $1`,
                [c.id],
              )
            )[0].n,
          );
        const holder = await h.holdAddress(c.addrId);
        try {
          const anon = h.anonymize(c.id, c.email);
          await h.waitBlocked(ADDR_DELETE);
          const v = svc.verifyEmail(h.adminId, c.email).then(
            () => 'verified',
            (e: { getStatus?: () => number }) => e.getStatus?.() ?? 'error',
          );
          await h.waitBlocked(LOCK_STMT);
          await holder.release();
          expect((await anon).status).toBe(200);
          expect(await v).toBe(404);
        } finally {
          await holder.abort();
        }
        expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
        expect(await events()).toBe(0);

        // AFTER the anonymization: the placeholder address of the account
        const placeholder = (
          await h.prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
        ).email;
        expect(placeholder.endsWith('@anonymized.invalid')).toBe(true);
        const res = await server()
          .post(`${BASE}/admin/customers/verify-email`)
          .set(h.auth())
          .send({ email: placeholder });
        expect(res.status).toBe(404);
        expect(res.body.errorCode).toBe('CUSTOMER_NOT_FOUND');
        expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
        expect(await events()).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.MANUAL_EMAIL_VERIFY_ENABLED;
        else process.env.MANUAL_EMAIL_VERIFY_ENABLED = prev;
      }
    });

    it('random: 5 account writes in parallel with the anonymization, 10 rounds: nothing of the person survives, no 5xx', async () => {
      for (let i = 0; i < 10; i++) {
        const { anon, results, left } = await h.randomRound(9_000 + i);
        const ctx = JSON.stringify({ round: i, anon: anon.status, results });
        expect(anon.status, ctx).toBe(200);
        for (const r of results) {
          expect([200, 201, 401], ctx).toContain(r.status);
        }
        expect(left, ctx).toEqual(h.CLEAN);
      }
    });
  },
);
