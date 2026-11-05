/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import pg from 'pg';
import { CartService } from './../src/cart/cart.service.js';
import { CUSTOMER_AUTH } from './../src/auth-core/auth-core.constants.js';
import type { CustomerAuth } from './../src/auth-core/customer-auth.factory.js';
import { lockCustomerForCheckout } from './../src/checkout/checkout-account-lock.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { withBuyerId } from './helpers/buyer-id.js';
import {
  BASE,
  bootHarness,
  type Cust,
  type Harness,
} from './helpers/account-write-race.js';

/**
 * Story 20.6a: the routes of an account wait a BOUNDED time for the lock of the account row and
 * answer the SAME clean, retryable response (409 `ACCOUNT_BUSY`, nothing written) instead of a 500
 * (Prisma's 5 s transaction timeout fired when the lock was released late). Plus:
 *   - the checkout takes the account's cart lock in the same order as the cart merge (no 40P01);
 *   - a token that BetterAuth writes after the anonymization's DELETE of tokens cannot be used;
 *   - `forgot-password` writes no token for an account being anonymized.
 */
const TAG = `b${randomUUID().replace(/-/g, '').slice(0, 7)}`;

type Ctx = { c: Cust; pid: string; h: Harness };
interface Route {
  name: string;
  setup?: (x: Ctx) => Promise<void>;
  call: (x: Ctx) => request.Test;
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
  return {
    release: async () => {
      if (done) return;
      done = true;
      await holder.query('COMMIT');
      await holder.end();
    },
    abort: async () => {
      if (done) return;
      done = true;
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    },
  };
}

describe(
  'Account routes: bounded lock waits, cart lock order, surviving tokens (e2e, Story 20.6a)',
  { timeout: 180_000 },
  () => {
    let h: Harness;
    const server = () => h.server();
    const jar = (x: Ctx) => ({ Cookie: x.c.cookie });
    const cartLine = (x: Ctx) =>
      x.h.prisma.cart.create({
        data: {
          customerId: x.c.id,
          expiresAt: new Date(Date.now() + 86_400_000),
          items: { create: [{ productId: x.pid, quantity: 1 }] },
        },
      });

    beforeAll(async () => {
      h = await bootHarness(TAG);
    });
    afterAll(async () => {
      await h.close();
    });

    const routes: Route[] = [
      {
        name: 'PATCH /auth/me',
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
        setup: async (x) => void (await cartLine(x)),
        call: (x) =>
          server()
            .patch(`${BASE}/cart/items/${x.pid}`)
            .set(jar(x))
            .send({ quantity: 2 }),
      },
      {
        name: 'DELETE /cart/items/:productId (account)',
        setup: async (x) => void (await cartLine(x)),
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
        name: 'POST /me/consent',
        call: (x) => server().post(`${BASE}/me/consent`).set(jar(x)).send({}),
      },
    ];

    it.each(routes)(
      '$name: a lock held by someone else is 409 ACCOUNT_BUSY within the bound (never 500), nothing written, and it works once released',
      async (route) => {
        const c = await h.mkCustomer('w');
        const x: Ctx = { c, pid: await h.mkProduct(), h };
        await route.setup?.(x);
        const before = await h.leftovers(c.id);
        const holder = await holdCustomerRow(c.id);
        let busy: request.Response;
        let ms: number;
        try {
          const t0 = Date.now();
          busy = await route.call(x).then((r) => r);
          ms = Date.now() - t0;
        } finally {
          await holder.release();
        }
        expect(busy.status, JSON.stringify(busy.body)).toBe(409);
        expect(busy.body.errorCode).toBe('ACCOUNT_BUSY');
        expect(ms).toBeGreaterThanOrEqual(2_000);
        expect(ms).toBeLessThan(4_500);
        // nothing written by the refused request
        const after = await h.leftovers(c.id);
        expect(after.name).toBe(before.name);
        expect(after.phone).toBe(before.phone);
        expect(after.addresses).toBe(before.addresses);
        // and the same request goes through once the lock is free (a lock held at a moment is not an error state)
        const ok = await route.call(x).then((r) => r);
        expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
      },
    );

    it('the QA scenario: a lock held 12 s never turns into a 500 when it is released (the request was already answered 409)', async () => {
      const c = await h.mkCustomer('q');
      const pid = await h.mkProduct();
      const holder = await holdCustomerRow(c.id);
      const t0 = Date.now();
      const inFlight = server()
        .post(`${BASE}/cart/items`)
        .set({ Cookie: c.cookie })
        .send({ productId: pid, quantity: 1 })
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 12_000));
      await holder.release();
      const res = await inFlight;
      expect(res.status).toBe(409);
      expect(res.body.errorCode).toBe('ACCOUNT_BUSY');
      expect(Date.now() - t0).toBeLessThan(13_000);
      // the cart of the account has nothing
      expect(await h.prisma.cart.count({ where: { customerId: c.id } })).toBe(
        0,
      );
    });

    it('login-time merge and the checkout lock answer the same ACCOUNT_BUSY (service level)', async () => {
      const c = await h.mkCustomer('m');
      const pid = await h.mkProduct();
      const guest = await h.mkGuestCart(pid);
      const holder = await holdCustomerRow(c.id);
      try {
        await expect(
          h.app.get(CartService).mergeAnonymousCart(c.id, guest),
        ).rejects.toMatchObject({
          status: 409,
          response: { errorCode: 'ACCOUNT_BUSY' },
        });
        await expect(
          h.prisma.$transaction((tx) => lockCustomerForCheckout(tx, c.id)),
        ).rejects.toMatchObject({
          status: 409,
          response: { errorCode: 'ACCOUNT_BUSY' },
        });
      } finally {
        await holder.release();
      }
      // the guest cart was not touched
      const gc = await h.prisma.cart.findUniqueOrThrow({
        where: { id: guest },
      });
      expect(gc.customerId).toBeNull();
    });

    it('lock_timeout is put back after the lock (the next statement of the transaction is not capped)', async () => {
      const c = await h.mkCustomer('t');
      const seen = await h.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', '7s', true)`;
        const { lockLiveCustomer } =
          await import('./../src/common/customer-write-lock.js');
        await lockLiveCustomer(tx, c.id);
        return tx.$queryRaw<
          { v: string }[]
        >`SELECT current_setting('lock_timeout') AS v`;
      });
      expect(seen[0].v).toBe('7s');
      const plain = await h.prisma.$transaction(async (tx) => {
        const { lockLiveCustomer } =
          await import('./../src/common/customer-write-lock.js');
        await lockLiveCustomer(tx, c.id);
        return tx.$queryRaw<
          { v: string }[]
        >`SELECT current_setting('lock_timeout') AS v`;
      });
      expect(plain[0].v).toBe('0');
    });

    // ---------------------------------------------------------------------------------------
    const checkoutBody = () =>
      withBuyerId({
        paymentRail: 'pago_movil',
        fulfillmentType: 'delivery',
        addressLine1: 'Av. Test 1',
        city: 'Caracas',
        state: 'Distrito Capital',
        recipientName: 'Maria Perez',
        recipientPhone: '0412-1234567',
      });

    describe('cart merge vs checkout (QA 20.6: DELETE "Carts" vs UPDATE "Carts" SET expiresAt)', () => {
      it('control: WITHOUT a common lock first, the two statement orders cross and Postgres kills one with 40P01 (the case QA saw)', async () => {
        const c = await h.mkCustomer('x');
        const pid = await h.mkProduct(10);
        const cart = await h.prisma.cart.create({
          data: {
            customerId: c.id,
            expiresAt: new Date(Date.now() + 86_400_000),
            items: { create: [{ productId: pid, quantity: 1 }] },
          },
        });
        // the SAME role as the app: `pg_stat_activity` only shows another role's statements to a superuser
        const u = new URL(process.env.DATABASE_URL!);
        u.searchParams.delete('schema');
        const mk = async () => {
          const cl = new pg.Client({ connectionString: u.toString() });
          await cl.connect();
          await cl.query('BEGIN');
          return cl;
        };
        const mergeTx = await mk();
        const checkoutTx = await mk();
        const codes: string[] = [];
        try {
          // merge: writes a line of the account cart (a row lock on Cart_Items) ...
          await mergeTx.query(
            `UPDATE "Cart_Items" SET "quantity" = "quantity" + 1 WHERE "cartId" = $1::uuid`,
            [cart.id],
          );
          // checkout: DELETE of the Carts row; it gets the row, then its cascade waits for the line
          const del = checkoutTx
            .query(`DELETE FROM "Carts" WHERE "id" = $1::uuid`, [cart.id])
            .then(
              () => 'ok',
              (e: { code?: string }) => {
                codes.push(e.code ?? '?');
                return 'err';
              },
            );
          await h.waitBlocked('%DELETE FROM "Carts"%');
          // ... and then the merge UPDATEs the same Carts row: a cycle
          const upd = mergeTx
            .query(
              `UPDATE "Carts" SET "expiresAt" = now() + interval '1 day' WHERE "id" = $1::uuid`,
              [cart.id],
            )
            .then(
              () => 'ok',
              (e: { code?: string }) => {
                codes.push(e.code ?? '?');
                return 'err';
              },
            );
          await Promise.all([del, upd]);
          expect(codes).toContain('40P01');
        } finally {
          await mergeTx.query('ROLLBACK').catch(() => undefined);
          await checkoutTx.query('ROLLBACK').catch(() => undefined);
          await mergeTx.end().catch(() => undefined);
          await checkoutTx.end().catch(() => undefined);
        }
      });

      it('deterministic: while a cart merge holds the account cart lock, the checkout WAITS for it (same lock order) and then completes with ONE order', async () => {
        const c = await h.mkCustomer('d');
        const pid = await h.mkProduct(10);
        await server()
          .post(`${BASE}/cart/items`)
          .set({ Cookie: c.cookie })
          .send({ productId: pid, quantity: 1 })
          .expect(201);
        // a "merge in flight": it holds the account's cart lock, as `mergeAnonymousCart` does
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const merge = new pg.Client({ connectionString: u.toString() });
        await merge.connect();
        await merge.query('BEGIN');
        await merge.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          ['cart:' + c.id],
        );
        try {
          const co = server()
            .post(`${BASE}/checkout`)
            .set({ Cookie: c.cookie })
            .send(checkoutBody())
            .then((r) => r);
          await h.waitBlocked('%pg_advisory_xact_lock%');
          await merge.query('COMMIT');
          const res = await co;
          expect(res.status, JSON.stringify(res.body)).toBe(201);
        } finally {
          await merge.query('ROLLBACK').catch(() => undefined);
          await merge.end().catch(() => undefined);
        }
        expect(
          await h.prisma.order.count({ where: { customerId: c.id } }),
        ).toBe(1);
      });

      it('rounds under load (Promise.all, merge of a guest cart vs checkout of the account cart): never a 5xx, never two orders, the guest cart is consumed at most once', async () => {
        const ROUNDS = 30;
        const outcomes: string[] = [];
        for (let i = 0; i < ROUNDS; i++) {
          const c = await h.mkCustomer(`r${i}`);
          const pid = await h.mkProduct(50);
          const pid2 = await h.mkProduct(50);
          await server()
            .post(`${BASE}/cart/items`)
            .set({ Cookie: c.cookie })
            .send({ productId: pid, quantity: 1 })
            .expect(201);
          const guest = await h.prisma.cart.create({
            data: {
              expiresAt: new Date(Date.now() + 86_400_000),
              items: {
                create: [
                  { productId: pid, quantity: 2 },
                  { productId: pid2, quantity: 1 },
                ],
              },
            },
          });
          const later = <T>(ms: number, fn: () => PromiseLike<T>) =>
            new Promise<T>((resolve, reject) => {
              setTimeout(() => {
                fn().then(resolve, reject);
              }, ms);
            });
          const off = (i % 7) * 3 - 9;
          const [co, mg] = await Promise.all([
            later(Math.max(0, -off), () =>
              server()
                .post(`${BASE}/checkout`)
                .set({ Cookie: c.cookie })
                .send(checkoutBody())
                .then((r) => r),
            ),
            later(Math.max(0, off), () =>
              h.app
                .get(CartService)
                .mergeAnonymousCart(c.id, guest.id)
                .then(
                  (v) => (v ? 'merged' : 'noop'),
                  (e: { status?: number }) => `err${e.status ?? '?'}`,
                ),
            ),
          ]);
          expect(co.status, JSON.stringify(co.body)).toBeLessThan(500);
          expect(['merged', 'noop']).toContain(mg);
          const orders = await h.prisma.order.count({
            where: { customerId: c.id },
          });
          expect(orders).toBe(co.status === 201 ? 1 : 0);
          outcomes.push(`${co.status}/${mg}`);
        }
        process.stdout.write(
          `[20.6a cart merge vs checkout] ${outcomes.join(' ')}\n`,
        );
      });
    });

    // ---------------------------------------------------------------------------------------
    describe('tokens that outlive the anonymization', () => {
      const anonymized = async () => {
        const c = await h.mkCustomer('tk');
        const a = await h.anonymize(c.id, c.email);
        expect(a.status).toBe(200);
        return c;
      };
      const resetBody = (token: string) => ({
        token,
        password: 'brand-new-password-20-6a',
      });
      const passwordResetEvents = async (id: string) =>
        Number(
          (
            await h.sql(
              `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action" = 'CUSTOMER_PASSWORD_RESET' AND "actorId" = $1::uuid`,
              [id],
            )
          )[0].n,
        );

      it('reset-password with a token written AFTER the anonymization answers exactly like an invalid token: no password, no session, no event, the token is gone', async () => {
        const c = await anonymized();
        // the race: BetterAuth stored the reset token after the DELETE of tokens (simulated here)
        const ctx = await h.app.get<CustomerAuth>(CUSTOMER_AUTH).$context;
        const token = `tok-${randomUUID()}`;
        await ctx.internalAdapter.createVerificationValue({
          identifier: `reset-password:${token}`,
          value: c.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        const bad = await server()
          .post(`${BASE}/auth/reset-password`)
          .send(resetBody(`nope-${randomUUID()}`));
        const res = await server()
          .post(`${BASE}/auth/reset-password`)
          .send(resetBody(token));
        expect(res.status).toBe(400);
        expect(res.body).toEqual(bad.body);
        expect(res.body.errorCode).toBe('INVALID_RESET_TOKEN');
        expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
        expect(await passwordResetEvents(c.id)).toBe(0);
        // a second try is the same answer (the token was dropped)
        const again = await server()
          .post(`${BASE}/auth/reset-password`)
          .send(resetBody(token));
        expect(again.status).toBe(400);
      });

      it('control: the same reset on a live account works and leaves its event', async () => {
        const c = await h.mkCustomer('ok');
        const ctx = await h.app.get<CustomerAuth>(CUSTOMER_AUTH).$context;
        const token = `tok-${randomUUID()}`;
        await ctx.internalAdapter.createVerificationValue({
          identifier: `reset-password:${token}`,
          value: c.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        const res = await server()
          .post(`${BASE}/auth/reset-password`)
          .send(resetBody(token));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await passwordResetEvents(c.id)).toBe(1);
      });

      it('forgot-password for an email whose account is being anonymized writes NO token (race at the worst moment: after the DELETE of tokens, before the commit)', async () => {
        const c = await h.mkCustomer('fg');
        const holder = await h.holdAddress(c.addrId);
        try {
          const anon = h.anonymize(c.id, c.email);
          // the anonymization already deleted the tokens and is blocked on the address row
          await h.waitBlocked('%Customer_Addresses%');
          // the account still looks live to anyone else: the lookup passes and BetterAuth is about to
          // write a token
          const forgot = await server()
            .post(`${BASE}/auth/forgot-password`)
            .send({ email: c.email });
          expect(forgot.status).toBe(200);
          await h.waitBlocked('%"Customers"%KEY SHARE%');
          await holder.release();
          expect((await anon).status).toBe(200);
        } finally {
          await holder.abort();
        }
        // let the background write finish (it saw anonymizedAt and did nothing)
        await new Promise((r) => setTimeout(r, 500));
        const tokens = await h.sql(
          `SELECT count(*)::int AS n FROM "Customer_Verifications" WHERE "value" = $1`,
          [c.id],
        );
        expect(Number(tokens[0].n)).toBe(0);
        expect(await h.leftovers(c.id)).toEqual(h.CLEAN);
      });

      it('forgot-password for an anonymized email answers like an unknown one and creates nothing', async () => {
        const c = await anonymized();
        const a = await server()
          .post(`${BASE}/auth/forgot-password`)
          .send({ email: c.email });
        const u = await server()
          .post(`${BASE}/auth/forgot-password`)
          .send({ email: `nadie-${randomUUID()}@212collectorsclub.test` });
        expect(a.status).toBe(u.status);
        expect(a.body).toEqual(u.body);
        expect(
          Number(
            (
              await h.sql(
                `SELECT count(*)::int AS n FROM "Customer_Verifications" WHERE "value" = $1`,
                [c.id],
              )
            )[0].n,
          ),
        ).toBe(0);
      });
    });
  },
);
