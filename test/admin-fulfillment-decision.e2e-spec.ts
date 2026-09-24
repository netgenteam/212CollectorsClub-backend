import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface CheckoutResponse {
  orderId: string;
}

interface ApiErrorBody {
  errorCode?: string;
  details?: Record<string, unknown>;
}

interface FulfillmentDecisionResponse {
  orderId: string;
  status: string;
  updatedAt: string;
}

const TEST_USERNAME = 'e2e-admin-story-9-3';
const TEST_EMAIL = 'e2e-admin-story-9-3@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-9f3c';

// Story 1.4 seed Products. OP_ROMANCE_DAWN_ID/DBS_UNION_FORCE_ID are already
// heavily reused across admin-orders.e2e-spec.ts/checkout.e2e-spec.ts/
// admin-payment-decision.e2e-spec.ts (ample stock, small per-test
// quantities, self-contained cleanup — same accepted-risk convention those
// files already document). CHARIZARD_VMAX_ID is dedicated SOLELY to this
// file's own concurrency test (never checked out by any other suite —
// cart.e2e-spec.ts only ever adds/removes it from a Cart, never calls
// /checkout), same isolation reasoning
// admin-payment-decision.e2e-spec.ts documents for its own
// ONE_PIECE_DECK_ID.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180
const DBS_UNION_FORCE_ID = '769f36ae-c8ea-4535-97df-11872d7915cc'; // stock 50
const CHARIZARD_VMAX_ID = 'f65915f5-2931-4e50-af95-630b1fd7b950'; // stock 12

function extractCartCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as
    string[] | undefined;
  const cartCookie = setCookie?.find((c) => c.startsWith('cartId='));
  if (!cartCookie) {
    throw new Error(
      `Expected a cartId Set-Cookie header, got: ${JSON.stringify(setCookie)}`,
    );
  }
  return cartCookie;
}

function pagoMovilPickupBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'pago_movil',
    fulfillmentType: 'pickup',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

/**
 * Story 9.3 (FR-27, NFR-4, NFR-6; AD-7, AD-16). Full-stack e2e coverage
 * (real AdminAuthGuard, real Postgres) of the 2 new admin routes: fulfill
 * and cancel. Every Order this suite acts on is pushed all the way to
 * `paid` through the REAL production path — a Pago Móvil checkout
 * (`createPagoMovilOrder`, same helper shape every other e2e suite in this
 * repo already uses) followed by a REAL call to Story 9.2's
 * `POST .../confirm-payment` (never a hand-inserted `status: 'PAID'` row)
 * — so `Product.stock` is already genuinely decremented and every
 * `StockHold` genuinely released by the time this suite's own
 * fulfill/cancel assertions run, exactly like production traffic.
 */
describe('AdminOrdersController — Story 9.3 fulfillment decisions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    accessToken = (loginRes.body as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  function authed(method: 'get' | 'post', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  /** Checks out (real Pago Móvil checkout, possibly multiple lines added to
   * the SAME cart) and immediately confirms via the REAL Story 9.2
   * `confirm-payment` route — the returned Order is `paid`, with
   * `Product.stock` already genuinely decremented for every line and every
   * `StockHold` genuinely released, exactly as production traffic would
   * leave it. */
  async function createPaidOrder(
    lines: { productId: string; quantity: number }[],
  ): Promise<string> {
    let cartCookie: string | undefined;
    for (const line of lines) {
      const req = request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: line.productId, quantity: line.quantity });
      if (cartCookie) {
        req.set('Cookie', cartCookie);
      }
      const res = await req.expect(201);
      cartCookie ??= extractCartCookie(res);
    }

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie!)
      .send(pagoMovilPickupBody())
      .expect(201);
    const orderId = (checkoutRes.body as CheckoutResponse).orderId;

    await authed(
      'post',
      `/api/v1/admin/orders/${orderId}/confirm-payment`,
    ).expect(200);

    return orderId;
  }

  /** Same checkout as above, WITHOUT the confirm step — the returned Order
   * stays `pending_verification`, with an active StockHold. Used only for
   * the "illegal transition from a non-paid status" tests below. */
  async function createPendingOrder(
    productId: string,
    quantity: number,
  ): Promise<string> {
    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId, quantity })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send(pagoMovilPickupBody())
      .expect(201);
    return (checkoutRes.body as CheckoutResponse).orderId;
  }

  /** Restores stock/heldQty for any Order this suite leaves in a
   * non-terminal state (still holding an active StockHold) and deletes the
   * Order — same cleanup discipline every other checkout-driving e2e suite
   * in this repo follows. Safe to call on an already-fully-resolved Order
   * too (findMany simply returns no active holds). Does NOT restore
   * `stock` for a fulfilled/cancelled Order — callers of `createPaidOrder`
   * must do that themselves, since only THEY know whether the test's own
   * cancel call already gave it back. */
  async function cleanupOrder(orderId: string): Promise<void> {
    const holds = await prisma.stockHold.findMany({
      where: { orderId, releasedAt: null },
      select: { productId: true, quantity: true },
    });
    for (const hold of holds) {
      await prisma.product.update({
        where: { id: hold.productId },
        data: { heldQty: { decrement: hold.quantity } },
      });
    }
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
  }

  describe('AdminAuthGuard gating on both routes', () => {
    const randomOrderId = '11111111-1111-1111-1111-111111111111';

    it('POST fulfill: 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${randomOrderId}/fulfill`)
        .expect(401);
    });

    it('POST cancel: 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${randomOrderId}/cancel`)
        .expect(401);
    });
  });

  describe('malformed orderId: 400, never a raw 500', () => {
    it('POST fulfill with a non-UUID orderId', async () => {
      await authed('post', '/api/v1/admin/orders/not-a-uuid/fulfill').expect(
        400,
      );
    });

    it('POST cancel with a non-UUID orderId', async () => {
      await authed('post', '/api/v1/admin/orders/not-a-uuid/cancel').expect(
        400,
      );
    });
  });

  describe('POST /admin/orders/:orderId/fulfill (AC1, AC3)', () => {
    it('404 ORDER_NOT_FOUND for an Order that does not exist', async () => {
      const res = await authed(
        'post',
        '/api/v1/admin/orders/22222222-2222-4222-8222-222222222222/fulfill',
      ).expect(404);
      expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('fulfills: paid -> fulfilled, OrderStatusHistory row has actorType=admin + adminUserId, stock is left EXACTLY as confirm-payment already decremented it (never touched again)', async () => {
      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 2 },
      ]);
      const afterConfirm = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/fulfill`,
        ).expect(200);
        const body = res.body as FulfillmentDecisionResponse;
        expect(body.orderId).toBe(orderId);
        expect(body.status).toBe('fulfilled');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('FULFILLED');
        const rows = order.statusHistory.filter(
          (h) => h.toStatus === 'FULFILLED',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].actorType).toBe('ADMIN');
        expect(rows[0].adminUserId).toBe(adminId);
        expect(rows[0].fromStatus).toBe('PAID');

        const after = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        expect(after.stock).toBe(afterConfirm.stock);
      } finally {
        await cleanupOrder(orderId);
        // fulfill never restores stock (nothing was un-sold) — restore the
        // 2 units consumed by confirm-payment ourselves, same discipline
        // admin-payment-decision.e2e-spec.ts's own confirm tests use.
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 2 } },
        });
      }
    });

    it('409 ORDER_NOT_PAID for an Order still pending_verification — explicit conflict, never a silent state change', async () => {
      const orderId = await createPendingOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/fulfill`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PAID');
        expect(errBody.details).toEqual({
          currentStatus: 'pending_verification',
        });

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('PENDING_VERIFICATION');
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('409 ORDER_NOT_PAID on a duplicate fulfill — never reverts the terminal fulfilled state', async () => {
      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 1 },
      ]);
      try {
        await authed('post', `/api/v1/admin/orders/${orderId}/fulfill`).expect(
          200,
        );

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/fulfill`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PAID');
        expect(errBody.details).toEqual({ currentStatus: 'fulfilled' });

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('FULFILLED');
      } finally {
        await cleanupOrder(orderId);
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 1 } },
        });
      }
    });

    it('a cancelled Order cannot be fulfilled afterward either (symmetric terminal-state guard)', async () => {
      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 1 },
      ]);
      try {
        await authed('post', `/api/v1/admin/orders/${orderId}/cancel`).expect(
          200,
        );

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/fulfill`,
        ).expect(409);
        expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_PAID');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('CANCELLED');
      } finally {
        await cleanupOrder(orderId);
        // cancel already restored stock — nothing left to increment here.
      }
    });
  });

  describe('POST /admin/orders/:orderId/cancel (AC2, AC3)', () => {
    it('404 ORDER_NOT_FOUND for an Order that does not exist', async () => {
      const res = await authed(
        'post',
        '/api/v1/admin/orders/22222222-2222-4222-8222-222222222222/cancel',
      ).expect(404);
      expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('cancels a multi-line Order: paid -> cancelled, stock re-incremented correctly for BOTH products, OrderStatusHistory row has actorType=admin + adminUserId', async () => {
      const beforeA = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });
      const beforeB = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });

      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 3 },
        { productId: DBS_UNION_FORCE_ID, quantity: 2 },
      ]);

      // Sanity: confirm-payment really did decrement both lines before we
      // even attempt the cancel, so the re-increment assertion below is
      // proving a real round-trip, not a no-op.
      const afterConfirmA = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });
      const afterConfirmB = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      expect(afterConfirmA.stock).toBe(beforeA.stock - 3);
      expect(afterConfirmB.stock).toBe(beforeB.stock - 2);

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/cancel`,
        ).expect(200);
        const body = res.body as FulfillmentDecisionResponse;
        expect(body.status).toBe('cancelled');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('CANCELLED');
        const rows = order.statusHistory.filter(
          (h) => h.toStatus === 'CANCELLED',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].actorType).toBe('ADMIN');
        expect(rows[0].adminUserId).toBe(adminId);
        expect(rows[0].fromStatus).toBe('PAID');

        const afterCancelA = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        const afterCancelB = await prisma.product.findUniqueOrThrow({
          where: { id: DBS_UNION_FORCE_ID },
        });
        expect(afterCancelA.stock).toBe(beforeA.stock);
        expect(afterCancelB.stock).toBe(beforeB.stock);
      } finally {
        // cancel already restored both products' stock — cleanupOrder only
        // needs to delete the (already hold-free) Order row.
        await cleanupOrder(orderId);
      }
    });

    it('409 ORDER_NOT_PAID for an Order still pending_verification — explicit conflict, stock/heldQty untouched', async () => {
      const orderId = await createPendingOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/cancel`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PAID');
        expect(errBody.details).toEqual({
          currentStatus: 'pending_verification',
        });

        const hold = await prisma.stockHold.findFirstOrThrow({
          where: { orderId },
        });
        expect(hold.releasedAt).toBeNull();
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('409 ORDER_NOT_PAID on a duplicate cancel — never re-increments stock twice', async () => {
      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 1 },
      ]);
      try {
        await authed('post', `/api/v1/admin/orders/${orderId}/cancel`).expect(
          200,
        );
        const afterFirst = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/cancel`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PAID');
        expect(errBody.details).toEqual({ currentStatus: 'cancelled' });

        const afterSecond = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        expect(afterSecond.stock).toBe(afterFirst.stock);
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('a fulfilled Order cannot be cancelled afterward either (symmetric terminal-state guard, no stock leak)', async () => {
      const orderId = await createPaidOrder([
        { productId: OP_ROMANCE_DAWN_ID, quantity: 1 },
      ]);
      try {
        await authed('post', `/api/v1/admin/orders/${orderId}/fulfill`).expect(
          200,
        );
        const afterFulfill = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/cancel`,
        ).expect(409);
        expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_PAID');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('FULFILLED');
        const afterAttemptedCancel = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        expect(afterAttemptedCancel.stock).toBe(afterFulfill.stock);
      } finally {
        await cleanupOrder(orderId);
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 1 } },
        });
      }
    });

    it('concurrency: simultaneous fulfill and cancel on the SAME paid Order resolve to exactly one 200 and one 409 — stock reflects EXACTLY the winning action, never both, never neither', async () => {
      const originalStock = (
        await prisma.product.findUniqueOrThrow({
          where: { id: CHARIZARD_VMAX_ID },
        })
      ).stock;

      const orderId = await createPaidOrder([
        { productId: CHARIZARD_VMAX_ID, quantity: 1 },
      ]);
      const afterConfirm = await prisma.product.findUniqueOrThrow({
        where: { id: CHARIZARD_VMAX_ID },
      });
      expect(afterConfirm.stock).toBe(originalStock - 1);

      try {
        const [fulfillRes, cancelRes] = await Promise.all([
          authed('post', `/api/v1/admin/orders/${orderId}/fulfill`),
          authed('post', `/api/v1/admin/orders/${orderId}/cancel`),
        ]);

        const statuses = [fulfillRes.status, cancelRes.status].sort();
        expect(statuses).toEqual([200, 409]);

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        // Exactly one terminal transition ever left `paid` — never two,
        // never zero.
        const terminalRows = order.statusHistory.filter(
          (h) => h.fromStatus === 'PAID',
        );
        expect(terminalRows).toHaveLength(1);

        const finalProduct = await prisma.product.findUniqueOrThrow({
          where: { id: CHARIZARD_VMAX_ID },
        });

        if (fulfillRes.status === 200) {
          expect((fulfillRes.body as FulfillmentDecisionResponse).status).toBe(
            'fulfilled',
          );
          expect((cancelRes.body as ApiErrorBody).errorCode).toBe(
            'ORDER_NOT_PAID',
          );
          expect(order.status).toBe('FULFILLED');
          // fulfill never touches stock — still decremented exactly once.
          expect(finalProduct.stock).toBe(afterConfirm.stock);
        } else {
          expect((cancelRes.body as FulfillmentDecisionResponse).status).toBe(
            'cancelled',
          );
          expect((fulfillRes.body as ApiErrorBody).errorCode).toBe(
            'ORDER_NOT_PAID',
          );
          expect(order.status).toBe('CANCELLED');
          // cancel gave the 1 unit back exactly once.
          expect(finalProduct.stock).toBe(originalStock);
        }
      } finally {
        await cleanupOrder(orderId);
        // Deterministic restore regardless of which side of the race won.
        await prisma.product.update({
          where: { id: CHARIZARD_VMAX_ID },
          data: { stock: originalStock },
        });
      }
    });
  });
});
