import { randomBytes, createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

// Story 5.1 e2e suite. Most tests build an Order fixture directly via
// Prisma (bypassing cart/checkout entirely — same reasoning
// proof-of-payment.e2e-spec.ts already documents: this suite's own scope
// is the two lookup routes themselves, not checkout, and every seeded
// catalog Product is already claimed by some other *.e2e-spec.ts file's
// own stock/heldQty mutations). The two tests that need REAL transitions
// (multi-row history, the FR-16 regression) instead drive a genuine
// checkout + PayPal webhook confirmation, reusing OP_ROMANCE_DAWN_ID
// (already claimed by checkout.e2e-spec.ts, but ONLY for its `heldQty`/
// StockHold mutations there — pago_movil never reaches Story 4.3's PayPal
// `stock`-decrement path). This file is the first to touch THIS product's
// `stock` column directly, always restores it in a `finally` block, and
// never asserts an absolute stock value (only that ITS OWN Order/history
// rows come out correct) — so it carries no cross-file flakiness risk
// even under parallel file execution.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180

interface OrderFulfillmentResponse {
  type: string;
  recipientName: string;
  recipientPhone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface OrderDetailResponse {
  orderId: string;
  status: string;
  paymentRail: string;
  fulfillment: OrderFulfillmentResponse;
  totalUsd: number;
  fxRateVesPerUsd: number | null;
  totalVes: number | null;
  lines: { productId: string; productName: string; quantity: number }[];
  createdAt: string;
  updatedAt: string;
}

interface OrderStatusHistoryEntryResponse {
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  createdAt: string;
}

interface CheckoutResponse {
  orderId: string;
  status: string;
  orderAccessToken: string;
  paypal: { paypalOrderId: string; approveUrl: string } | null;
}

interface WebhookAckResponse {
  received: boolean;
  outcome: 'paid' | 'payment_failed' | 'noop';
}

interface ApiErrorBody {
  errorCode?: string;
}

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

describe('Order status lookup + history (e2e, Story 5.1)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

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
  });

  afterEach(async () => {
    await app.close();
  });

  /** Creates a real Order row directly via Prisma with a real
   * orderAccessToken hashed the exact same way CheckoutService does (see
   * this suite's own top-of-file comment), one real OrderLine referencing
   * OP_ROMANCE_DAWN_ID (read-only FK reference — never mutates that
   * Product), and, unless suppressed, the single `[]->status` creation
   * OrderStatusHistory row `recordInitialOrderStatus` would have written
   * for a real checkout. */
  async function createTestOrder(
    overrides: {
      status?: string;
      fulfillmentType?: 'DELIVERY' | 'PICKUP';
      paymentRail?: 'PAGO_MOVIL' | 'PAYPAL';
      withHistoryRow?: boolean;
    } = {},
  ): Promise<{ orderId: string; rawToken: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const accessTokenHash = createHash('sha256').update(rawToken).digest('hex');
    const status = overrides.status ?? 'PENDING_VERIFICATION';
    const paymentRail = overrides.paymentRail ?? 'PAGO_MOVIL';
    const fulfillmentType = overrides.fulfillmentType ?? 'PICKUP';
    const isDelivery = fulfillmentType === 'DELIVERY';
    const isPaypal = paymentRail === 'PAYPAL';

    const order = await prisma.order.create({
      data: {
        status: status as never,
        paymentRail: paymentRail as never,
        fulfillmentType: fulfillmentType as never,
        recipientName: 'Order Lookup Test Buyer',
        recipientPhone: '0412-0000000',
        addressLine1: isDelivery ? 'Calle Falsa 123' : null,
        addressLine2: isDelivery ? 'Apto 4B' : null,
        city: isDelivery ? 'Caracas' : null,
        state: isDelivery ? 'Distrito Capital' : null,
        country: isDelivery ? 'Venezuela' : null,
        totalUsd: '25.50' as never,
        fxRateVesPerUsd: isPaypal ? null : ('40.5000' as never),
        totalVes: isPaypal ? null : ('1033.00' as never),
        accessTokenHash,
        lines: {
          create: [
            {
              productId: OP_ROMANCE_DAWN_ID,
              productName: 'One Piece Romance Dawn Booster',
              unitPriceUsd: '12.75' as never,
              quantity: 2,
              lineTotalUsd: '25.50' as never,
            },
          ],
        },
      },
    });

    if (overrides.withHistoryRow !== false) {
      await prisma.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: null,
          toStatus: status as never,
          actorType: 'SYSTEM' as never,
        },
      });
    }

    return { orderId: order.id, rawToken };
  }

  async function cleanupOrder(orderId: string): Promise<void> {
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
  }

  /** Drives a REAL HTTP add-to-cart + paypal checkout against
   * OP_ROMANCE_DAWN_ID — used only by the two tests that need genuine
   * transitions (not a fixture), same helper shape as
   * payments-paypal.e2e-spec.ts's own `checkoutPaypal`. */
  async function checkoutPaypal(
    quantity: number,
  ): Promise<{ orderId: string; paypalOrderId: string; rawToken: string }> {
    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: OP_ROMANCE_DAWN_ID, quantity })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send({
        paymentRail: 'paypal',
        fulfillmentType: 'pickup',
        recipientName: 'Order Lookup E2E Buyer',
        recipientPhone: '0412-9999999',
      })
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;
    if (!body.paypal) {
      throw new Error(
        `Expected a paypal session on the checkout response, got: ${JSON.stringify(body)}`,
      );
    }
    return {
      orderId: body.orderId,
      paypalOrderId: body.paypal.paypalOrderId,
      rawToken: body.orderAccessToken,
    };
  }

  async function postWebhook(paypalOrderId: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/payments/paypal/webhook')
      .send({ paypalOrderId, eventType: 'PAYMENT.CAPTURE.COMPLETED' });
  }

  async function restoreStockAndDeleteOrder(
    orderId: string,
    restoreQty = 0,
  ): Promise<void> {
    if (restoreQty > 0) {
      await prisma.product.update({
        where: { id: OP_ROMANCE_DAWN_ID },
        data: { stock: { increment: restoreQty } },
      });
    }
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
  }

  describe('GET /api/v1/orders/:orderId', () => {
    it('valid token: returns current status, paymentRail, totals and fulfillment details', async () => {
      const { orderId, rawToken } = await createTestOrder({
        status: 'PENDING_VERIFICATION',
        fulfillmentType: 'PICKUP',
      });

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as OrderDetailResponse;
        if (body.orderId !== orderId) {
          throw new Error(`Expected orderId ${orderId}, got: ${body.orderId}`);
        }
        if (body.status !== 'pending_verification') {
          throw new Error(
            `Expected status pending_verification, got: ${body.status}`,
          );
        }
        if (body.paymentRail !== 'pago_movil') {
          throw new Error(
            `Expected paymentRail pago_movil, got: ${body.paymentRail}`,
          );
        }
        if (
          body.totalUsd !== 25.5 ||
          body.fxRateVesPerUsd !== 40.5 ||
          body.totalVes !== 1033
        ) {
          throw new Error(`Unexpected totals: ${JSON.stringify(body)}`);
        }
        if (body.fulfillment.type !== 'pickup') {
          throw new Error(
            `Expected fulfillment.type pickup, got: ${body.fulfillment.type}`,
          );
        }
        if (
          body.fulfillment.addressLine1 !== null ||
          body.fulfillment.city !== null ||
          body.fulfillment.country !== null
        ) {
          throw new Error(
            `Expected null address fields for a pickup Order, got: ${JSON.stringify(body.fulfillment)}`,
          );
        }
        if (
          body.lines.length !== 1 ||
          body.lines[0].productId !== OP_ROMANCE_DAWN_ID
        ) {
          throw new Error(`Unexpected lines: ${JSON.stringify(body.lines)}`);
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('a delivery Order returns its full address in fulfillment', async () => {
      const { orderId, rawToken } = await createTestOrder({
        fulfillmentType: 'DELIVERY',
      });

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as OrderDetailResponse;
        if (body.fulfillment.type !== 'delivery') {
          throw new Error(
            `Expected fulfillment.type delivery, got: ${body.fulfillment.type}`,
          );
        }
        if (
          body.fulfillment.addressLine1 !== 'Calle Falsa 123' ||
          body.fulfillment.city !== 'Caracas' ||
          body.fulfillment.country !== 'Venezuela'
        ) {
          throw new Error(
            `Expected the full delivery address, got: ${JSON.stringify(body.fulfillment)}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('a paypal Order returns null fxRateVesPerUsd/totalVes (AD-3)', async () => {
      const { orderId, rawToken } = await createTestOrder({
        paymentRail: 'PAYPAL',
        status: 'PAYMENT_PROCESSING',
      });

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as OrderDetailResponse;
        if (body.fxRateVesPerUsd !== null || body.totalVes !== null) {
          throw new Error(
            `Expected null VES fields for a paypal Order, got: ${JSON.stringify(body)}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 MISSING_ORDER_ACCESS_TOKEN when there is no Authorization header', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'MISSING_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 INVALID_ORDER_ACCESS_TOKEN when the token is simply wrong', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', 'Bearer this-is-not-the-right-token')
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'INVALID_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 INVALID_ORDER_ACCESS_TOKEN when the token is valid but for a DIFFERENT Order (no enumeration)', async () => {
      const orderA = await createTestOrder();
      const orderB = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderA.orderId}`)
          .set('Authorization', `Bearer ${orderB.rawToken}`)
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'INVALID_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderA.orderId);
        await cleanupOrder(orderB.orderId);
      }
    });
  });

  describe('GET /api/v1/orders/:orderId/history', () => {
    it('an Order that has never left its initial state still returns its single creation row — never an empty array (AC3)', async () => {
      const { orderId, rawToken } = await createTestOrder({
        status: 'PENDING_VERIFICATION',
      });

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/history`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as OrderStatusHistoryEntryResponse[];
        if (!Array.isArray(body) || body.length !== 1) {
          throw new Error(
            `Expected exactly 1 history row, got: ${JSON.stringify(body)}`,
          );
        }
        if (
          body[0].fromStatus !== null ||
          body[0].toStatus !== 'pending_verification' ||
          body[0].actorType !== 'system'
        ) {
          throw new Error(
            `Unexpected creation row: ${JSON.stringify(body[0])}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 MISSING_ORDER_ACCESS_TOKEN when there is no Authorization header', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/history`)
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'MISSING_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 INVALID_ORDER_ACCESS_TOKEN when the token is valid but for a DIFFERENT Order', async () => {
      const orderA = await createTestOrder();
      const orderB = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderA.orderId}/history`)
          .set('Authorization', `Bearer ${orderB.rawToken}`)
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'INVALID_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderA.orderId);
        await cleanupOrder(orderB.orderId);
      }
    });

    it('reflects multiple REAL transitions from an actual checkout + PayPal webhook confirmation (creation row, then paid row, oldest first)', async () => {
      const { orderId, paypalOrderId, rawToken } = await checkoutPaypal(1);

      try {
        const webhookRes = await postWebhook(paypalOrderId);
        const ack = webhookRes.body as WebhookAckResponse;
        if (webhookRes.status !== 200 || ack.outcome !== 'paid') {
          throw new Error(
            `Expected the webhook to confirm payment, got ${webhookRes.status}: ${JSON.stringify(webhookRes.body)}`,
          );
        }

        const historyRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/history`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);
        const history = historyRes.body as OrderStatusHistoryEntryResponse[];

        if (history.length !== 2) {
          throw new Error(
            `Expected exactly 2 history rows, got: ${JSON.stringify(history)}`,
          );
        }
        if (
          history[0].fromStatus !== null ||
          history[0].toStatus !== 'payment_processing' ||
          history[0].actorType !== 'system'
        ) {
          throw new Error(
            `Unexpected creation row: ${JSON.stringify(history[0])}`,
          );
        }
        if (
          history[1].fromStatus !== 'payment_processing' ||
          history[1].toStatus !== 'paid' ||
          history[1].actorType !== 'paypal_webhook'
        ) {
          throw new Error(
            `Unexpected paid transition row: ${JSON.stringify(history[1])}`,
          );
        }
        if (
          new Date(history[0].createdAt).getTime() >
          new Date(history[1].createdAt).getTime()
        ) {
          throw new Error('Expected the history to be ordered oldest-first');
        }

        // The status endpoint reads consistently too, while we're here.
        const detailRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);
        const detail = detailRes.body as OrderDetailResponse;
        if (detail.status !== 'paid') {
          throw new Error(`Expected detail.status=paid, got: ${detail.status}`);
        }
      } finally {
        await restoreStockAndDeleteOrder(orderId, 1);
      }
    });

    it('FR-16 regression: a duplicate PayPal webhook confirmation never produces a second →paid OrderStatusHistory row', async () => {
      const { orderId, paypalOrderId, rawToken } = await checkoutPaypal(1);

      try {
        const firstRes = await postWebhook(paypalOrderId);
        const firstAck = firstRes.body as WebhookAckResponse;
        if (firstAck.outcome !== 'paid') {
          throw new Error(
            `Expected the first confirmation outcome=paid, got: ${JSON.stringify(firstRes.body)}`,
          );
        }

        // The duplicate — same paypalOrderId, second delivery (PayPal
        // retries webhooks that don't behave, per Story 4.3).
        const secondRes = await postWebhook(paypalOrderId);
        const secondAck = secondRes.body as WebhookAckResponse;
        if (secondAck.outcome !== 'noop') {
          throw new Error(
            `Expected the duplicate confirmation outcome=noop, got: ${JSON.stringify(secondRes.body)}`,
          );
        }

        const historyRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/history`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);
        const history = historyRes.body as OrderStatusHistoryEntryResponse[];

        const paidRows = history.filter((row) => row.toStatus === 'paid');
        if (paidRows.length !== 1) {
          throw new Error(
            `FR-16 VIOLATION: expected exactly one →paid row for this Order, got ${paidRows.length}: ${JSON.stringify(history)}`,
          );
        }
        if (history.length !== 2) {
          throw new Error(
            `Expected exactly 2 total rows (creation + the single paid transition — nothing from the duplicate), got: ${JSON.stringify(history)}`,
          );
        }
      } finally {
        await restoreStockAndDeleteOrder(orderId, 1);
      }
    });
  });
});
