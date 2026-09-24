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
  orderAccessToken: string;
}

interface ApiErrorBody {
  errorCode?: string;
  details?: Record<string, unknown>;
}

interface PaymentDecisionResponse {
  orderId: string;
  status: string;
  updatedAt: string;
}

const TEST_USERNAME = 'e2e-admin-story-9-2';
const TEST_EMAIL = 'e2e-admin-story-9-2@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-9f2c';

// Story 1.4 seed Products. OP_ROMANCE_DAWN_ID is already heavily reused
// across admin-orders.e2e-spec.ts/checkout.e2e-spec.ts/order-lookup.
// e2e-spec.ts (ample stock 180, small per-test quantities, self-contained
// cleanup — same accepted-risk convention those files already document).
// ONE_PIECE_DECK_ID is dedicated SOLELY to this file's own concurrency
// tests below (never checked out by any other suite — cart.e2e-spec.ts
// only ever adds/removes it from a Cart, never calls /checkout, so its
// `stock` column is never mutated by anything but this file), for the
// exact same isolation reason payments-paypal.e2e-spec.ts dedicates
// MTG_PLANESWALKER_ID to its own concurrency test.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180
const ONE_PIECE_DECK_ID = '8bae3dd3-da83-4509-9ee6-07ee83fb5954'; // stock 60

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

const VALID_PNG_BUFFER = Buffer.from('fake-png-bytes-for-story-9-2-testing');

/**
 * Story 9.2 (FR-16, FR-25, NFR-5, NFR-6; AD-7, AD-11, AD-12, AD-13, AD-16).
 * Full-stack e2e coverage (real AdminAuthGuard, real Postgres, real
 * checkout-created StockHold) of the 3 new admin routes: proof-of-payment
 * download, confirm-payment, reject-payment. Every Order this suite acts on
 * goes through a REAL Pago Móvil checkout (`createPagoMovilOrder`, same
 * helper shape `admin-orders.e2e-spec.ts` already established) so a real
 * `StockHold` row exists to be converted/released, exactly like production
 * traffic — never a bypassed/hand-inserted Order row (unlike
 * `proof-of-payment.e2e-spec.ts`'s own fixture helper, which deliberately
 * skips checkout and therefore never creates a StockHold — not suitable
 * here, since the whole point of this story is proving the StockHold gets
 * consumed/released correctly).
 */
describe('AdminOrdersController — Story 9.2 payment decisions (e2e)', () => {
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

  /** Real Pago Móvil checkout — the resulting Order is `pending_verification`
   * with a real, active StockHold, plus the buyer's one-time
   * orderAccessToken (needed to also exercise the real proof-of-payment
   * upload route as this Order's buyer would). */
  async function createPagoMovilOrder(
    productId: string,
    quantity: number,
  ): Promise<{ orderId: string; orderAccessToken: string }> {
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
    const body = checkoutRes.body as CheckoutResponse;
    return { orderId: body.orderId, orderAccessToken: body.orderAccessToken };
  }

  async function uploadProof(
    orderId: string,
    orderAccessToken: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/proof-of-payment`)
      .set('Authorization', `Bearer ${orderAccessToken}`)
      .attach('file', VALID_PNG_BUFFER, {
        filename: 'transferencia.png',
        contentType: 'image/png',
      })
      .expect(201);
  }

  /** Restores stock/heldQty for any Order this suite leaves in a non-final
   * state (still holding an active StockHold) and deletes the Order —
   * same cleanup discipline every other checkout-driving e2e suite in this
   * repo follows. Safe to call on an already-fully-resolved Order too
   * (findMany simply returns no active holds). */
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

  /** For the "insufficient stock at confirmation time" scenario: directly
   * drops `Product.stock` below the held quantity, simulating stock
   * running out between checkout and the admin's later confirmation
   * (e.g. an admin direct stock adjustment, Story 8.3, or another Order's
   * confirmation racing in between). Returns the original stock so the
   * test can restore it in `finally`. */
  async function starveStock(productId: string): Promise<number> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { stock: 0 },
    });
    return product.stock;
  }

  describe('AdminAuthGuard gating on all 3 routes', () => {
    const randomOrderId = '11111111-1111-1111-1111-111111111111';

    it('GET proof-of-payment: 401 without a token', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${randomOrderId}/proof-of-payment`)
        .expect(401);
    });

    it('POST confirm-payment: 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${randomOrderId}/confirm-payment`)
        .expect(401);
    });

    it('POST reject-payment: 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${randomOrderId}/reject-payment`)
        .expect(401);
    });
  });

  describe('malformed orderId: 400, never a raw 500', () => {
    it('GET proof-of-payment with a non-UUID orderId', async () => {
      await authed(
        'get',
        '/api/v1/admin/orders/not-a-uuid/proof-of-payment',
      ).expect(400);
    });

    it('POST confirm-payment with a non-UUID orderId', async () => {
      await authed(
        'post',
        '/api/v1/admin/orders/not-a-uuid/confirm-payment',
      ).expect(400);
    });
  });

  describe('GET /admin/orders/:orderId/proof-of-payment (AC1)', () => {
    it('404 ORDER_NOT_FOUND for an Order that does not exist', async () => {
      const res = await authed(
        'get',
        '/api/v1/admin/orders/22222222-2222-4222-8222-222222222222/proof-of-payment',
      ).expect(404);
      expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('404 PROOF_OF_PAYMENT_NOT_FOUND for a real Order with nothing uploaded yet', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        const res = await authed(
          'get',
          `/api/v1/admin/orders/${orderId}/proof-of-payment`,
        ).expect(404);
        expect((res.body as ApiErrorBody).errorCode).toBe(
          'PROOF_OF_PAYMENT_NOT_FOUND',
        );
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('serves the real uploaded file, forced as an attachment download, never inline', async () => {
      const { orderId, orderAccessToken } = await createPagoMovilOrder(
        OP_ROMANCE_DAWN_ID,
        1,
      );
      try {
        await uploadProof(orderId, orderAccessToken);

        const res = await authed(
          'get',
          `/api/v1/admin/orders/${orderId}/proof-of-payment`,
        ).expect(200);

        expect(res.headers['content-type']).toContain('image/png');
        expect(res.headers['content-disposition']).toContain('attachment');
        // The uploaded bytes are actually served back — checked via
        // Content-Length, robust regardless of how supertest happens to
        // buffer an arbitrary binary content-type into res.body/res.text.
        expect(Number(res.headers['content-length'])).toBe(
          VALID_PNG_BUFFER.length,
        );
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it("is NEVER reachable through the buyer-facing orders/:orderId/proof-of-payment route's own token, nor any static path — only this admin route serves it", async () => {
      const { orderId, orderAccessToken } = await createPagoMovilOrder(
        OP_ROMANCE_DAWN_ID,
        1,
      );
      try {
        await uploadProof(orderId, orderAccessToken);
        const row = await prisma.proofOfPayment.findFirstOrThrow({
          where: { orderId },
        });

        // No static-serve root exists for uploads/private/ at all (AD-12).
        await request(app.getHttpServer())
          .get(`/uploads/private/${row.filePath}`)
          .expect(404);
        // The buyer's OWN token-gated route only ever returns JSON status
        // metadata (Story 4.2), never the raw file bytes.
        const buyerRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${orderAccessToken}`)
          .expect(200);
        expect(buyerRes.headers['content-type']).toContain('json');
      } finally {
        await cleanupOrder(orderId);
      }
    });
  });

  describe('POST /admin/orders/:orderId/confirm-payment (AC2, AC4)', () => {
    it('404 ORDER_NOT_FOUND for an Order that does not exist', async () => {
      const res = await authed(
        'post',
        '/api/v1/admin/orders/22222222-2222-4222-8222-222222222222/confirm-payment',
      ).expect(404);
      expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_FOUND');
    });

    it("confirms: Order -> paid, stock AND heldQty decremented atomically by AD-13's exact guard, StockHold released, OrderStatusHistory row has actorType=admin + adminUserId", async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 2);
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(200);
        const body = res.body as PaymentDecisionResponse;
        expect(body.orderId).toBe(orderId);
        expect(body.status).toBe('paid');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('PAID');
        const adminRows = order.statusHistory.filter(
          (h) => h.toStatus === 'PAID',
        );
        expect(adminRows).toHaveLength(1);
        expect(adminRows[0].actorType).toBe('ADMIN');
        expect(adminRows[0].adminUserId).toBe(adminId);
        expect(adminRows[0].fromStatus).toBe('PENDING_VERIFICATION');

        const after = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        expect(after.stock).toBe(before.stock - 2);
        // `before` was captured AFTER the checkout above already
        // incremented heldQty by 2 — confirming consumes that same hold,
        // so heldQty returns to its pre-checkout baseline.
        expect(after.heldQty).toBe(before.heldQty - 2);

        const holds = await prisma.stockHold.findMany({
          where: { orderId },
        });
        expect(holds).toHaveLength(1);
        expect(holds[0].releasedAt).not.toBeNull();
      } finally {
        await cleanupOrder(orderId);
        // cleanupOrder only restores heldQty for STILL-active holds; this
        // Order's confirmed decrement of `stock` needs its own restore.
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 2 } },
        });
      }
    });

    it('409 ORDER_NOT_PENDING_VERIFICATION on a duplicate confirm — explicit conflict, NEVER a silent 200, and never a double decrement', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(200);

        const afterFirst = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PENDING_VERIFICATION');
        expect(errBody.details).toEqual({ currentStatus: 'paid' });

        const afterSecond = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        expect(afterSecond.stock).toBe(afterFirst.stock);
      } finally {
        await cleanupOrder(orderId);
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 1 } },
        });
      }
    });

    it('409 INSUFFICIENT_STOCK when stock ran out between checkout and confirmation — Order stays pending_verification, no partial decrement', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      const originalStock = await starveStock(OP_ROMANCE_DAWN_ID);

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(409);
        expect((res.body as ApiErrorBody).errorCode).toBe('INSUFFICIENT_STOCK');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('PENDING_VERIFICATION');

        const product = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        // Stock is still 0 (the guard aborted BEFORE ever decrementing —
        // never negative, never partially applied) and heldQty is
        // untouched (the hold was never released either).
        expect(product.stock).toBe(0);

        const hold = await prisma.stockHold.findFirstOrThrow({
          where: { orderId },
        });
        expect(hold.releasedAt).toBeNull();
      } finally {
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: originalStock },
        });
        await cleanupOrder(orderId);
      }
    });

    it('concurrency: two simultaneous confirmations for the SAME Order resolve to exactly one 200/paid and one 409, stock decremented exactly once (never double)', async () => {
      const { orderId } = await createPagoMovilOrder(ONE_PIECE_DECK_ID, 3);
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: ONE_PIECE_DECK_ID },
      });

      try {
        const [resA, resB] = await Promise.all([
          authed('post', `/api/v1/admin/orders/${orderId}/confirm-payment`),
          authed('post', `/api/v1/admin/orders/${orderId}/confirm-payment`),
        ]);

        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([200, 409]);
        const winner = resA.status === 200 ? resA : resB;
        const loser = resA.status === 200 ? resB : resA;
        expect((winner.body as PaymentDecisionResponse).status).toBe('paid');
        expect((loser.body as ApiErrorBody).errorCode).toBe(
          'ORDER_NOT_PENDING_VERIFICATION',
        );

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('PAID');
        expect(
          order.statusHistory.filter((h) => h.toStatus === 'PAID'),
        ).toHaveLength(1);

        const after = await prisma.product.findUniqueOrThrow({
          where: { id: ONE_PIECE_DECK_ID },
        });
        expect(after.stock).toBe(before.stock - 3);
        // Same "before already includes the checkout's own +3 heldQty"
        // reasoning as the single-confirm test above.
        expect(after.heldQty).toBe(before.heldQty - 3);
      } finally {
        await cleanupOrder(orderId);
        await prisma.product.update({
          where: { id: ONE_PIECE_DECK_ID },
          data: { stock: { increment: 3 } },
        });
      }
    });
  });

  describe('POST /admin/orders/:orderId/reject-payment (AC3, AC4)', () => {
    it('404 ORDER_NOT_FOUND for an Order that does not exist', async () => {
      const res = await authed(
        'post',
        '/api/v1/admin/orders/22222222-2222-4222-8222-222222222222/reject-payment',
      ).expect(404);
      expect((res.body as ApiErrorBody).errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('rejects: Order -> payment_rejected (terminal), StockHold released, stock left COMPLETELY untouched, only heldQty gives back the reservation', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 2);
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/reject-payment`,
        ).expect(200);
        const body = res.body as PaymentDecisionResponse;
        expect(body.status).toBe('payment_rejected');

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('PAYMENT_REJECTED');
        const rejectRows = order.statusHistory.filter(
          (h) => h.toStatus === 'PAYMENT_REJECTED',
        );
        expect(rejectRows).toHaveLength(1);
        expect(rejectRows[0].actorType).toBe('ADMIN');
        expect(rejectRows[0].adminUserId).toBe(adminId);

        const after = await prisma.product.findUniqueOrThrow({
          where: { id: OP_ROMANCE_DAWN_ID },
        });
        // stock is UNCHANGED — nothing was ever actually sold.
        expect(after.stock).toBe(before.stock);
        expect(after.heldQty).toBe(before.heldQty - 2);

        const hold = await prisma.stockHold.findFirstOrThrow({
          where: { orderId },
        });
        expect(hold.releasedAt).not.toBeNull();
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('409 ORDER_NOT_PENDING_VERIFICATION on a duplicate reject — explicit conflict, never a silent 200', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/reject-payment`,
        ).expect(200);

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/reject-payment`,
        ).expect(409);
        const errBody = res.body as ApiErrorBody;
        expect(errBody.errorCode).toBe('ORDER_NOT_PENDING_VERIFICATION');
        expect(errBody.details).toEqual({ currentStatus: 'payment_rejected' });
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('payment_rejected is terminal: confirming an already-rejected Order also 409s (no path back to pending, never resurrected into paid)', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/reject-payment`,
        ).expect(200);

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(409);
        expect((res.body as ApiErrorBody).errorCode).toBe(
          'ORDER_NOT_PENDING_VERIFICATION',
        );

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
        });
        expect(order.status).toBe('PAYMENT_REJECTED');
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('a paid Order cannot be rejected afterward either (symmetric terminal-state guard)', async () => {
      const { orderId } = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      try {
        await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/confirm-payment`,
        ).expect(200);

        const res = await authed(
          'post',
          `/api/v1/admin/orders/${orderId}/reject-payment`,
        ).expect(409);
        expect((res.body as ApiErrorBody).errorCode).toBe(
          'ORDER_NOT_PENDING_VERIFICATION',
        );
      } finally {
        await cleanupOrder(orderId);
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 1 } },
        });
      }
    });

    it('concurrency: two simultaneous rejections for the SAME Order resolve to exactly one 200 and one 409, heldQty released exactly once (never double-released)', async () => {
      const { orderId } = await createPagoMovilOrder(ONE_PIECE_DECK_ID, 2);
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: ONE_PIECE_DECK_ID },
      });

      try {
        const [resA, resB] = await Promise.all([
          authed('post', `/api/v1/admin/orders/${orderId}/reject-payment`),
          authed('post', `/api/v1/admin/orders/${orderId}/reject-payment`),
        ]);

        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([200, 409]);

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { statusHistory: true },
        });
        expect(order.status).toBe('PAYMENT_REJECTED');
        expect(
          order.statusHistory.filter((h) => h.toStatus === 'PAYMENT_REJECTED'),
        ).toHaveLength(1);

        const after = await prisma.product.findUniqueOrThrow({
          where: { id: ONE_PIECE_DECK_ID },
        });
        expect(after.stock).toBe(before.stock);
        // Released exactly once — not decremented twice (which would go
        // negative or below the pre-checkout baseline).
        expect(after.heldQty).toBe(before.heldQty - 2);
      } finally {
        await cleanupOrder(orderId);
      }
    });
  });
});
