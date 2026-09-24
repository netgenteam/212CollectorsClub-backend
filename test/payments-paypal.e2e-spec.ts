import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FakePaypalClient } from './../src/payments-paypal/fake-paypal-client.js';

type App = Parameters<typeof request>[0];

// Story 4.3: two Products (prisma/seed.ts) dedicated exclusively to this
// file, for the same cross-file-flakiness-under-parallel-execution reason
// checkout.e2e-spec.ts/proof-of-payment.e2e-spec.ts already document —
// every other seeded Product is already claimed elsewhere.
const DBS_UNION_FORCE_ID = '769f36ae-c8ea-4535-97df-11872d7915cc'; // stock 50
// Dedicated SOLELY to the concurrency test below — isolated from every
// other test in this file so its stock assertions can never be perturbed
// by another test's own mutation running in the same file.
const MTG_PLANESWALKER_ID = '79daad73-ebc4-4157-af82-2c9714e31668'; // stock 30

interface PaypalCheckoutSession {
  paypalOrderId: string;
  approveUrl: string;
}

interface CheckoutResponse {
  orderId: string;
  status: string;
  totalUsd: number;
  fxRateVesPerUsd: number | null;
  totalVes: number | null;
  lines: unknown[];
  paymentInstructions: unknown;
  paypal: PaypalCheckoutSession | null;
  orderAccessToken: string;
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

function paypalPickupBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'paypal',
    fulfillmentType: 'pickup',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

/**
 * Story 4.3 e2e suite. `AppModule`'s real DI wiring is used unmodified —
 * this dev environment has no PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET set
 * (see .env), so `paypalClientProvider` automatically binds `FakePaypalClient`
 * as `PAYPAL_CLIENT`, exactly as it would for a real `pnpm start:dev` run
 * with no PayPal credentials configured. `app.get(FakePaypalClient)`
 * retrieves that SAME singleton instance to script outcomes
 * (`setOutcome`) for orders created through real HTTP checkout calls —
 * this file never bypasses Nest's DI or reaches into CheckoutService
 * directly.
 *
 * No real PayPal API call is made or can be verified here — see the Story
 * 4.3 Dev report for exactly what remains to verify against a real
 * Sandbox once Angel has credentials.
 */
describe('PayPal checkout + webhook confirmation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fakePaypalClient: FakePaypalClient;

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
    fakePaypalClient = app.get(FakePaypalClient);
  });

  afterEach(async () => {
    await app.close();
  });

  /** Drives a real HTTP add-to-cart + paypal checkout, returning enough to
   * drive the rest of a test (and to clean up afterward). */
  async function checkoutPaypal(
    productId: string,
    quantity: number,
  ): Promise<{ orderId: string; paypalOrderId: string; rawToken: string }> {
    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId, quantity })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send(paypalPickupBody())
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
    restores: { productId: string; qty: number }[] = [],
  ): Promise<void> {
    for (const r of restores) {
      await prisma.product.update({
        where: { id: r.productId },
        data: { stock: { increment: r.qty } },
      });
    }
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
  }

  it('successful paypal checkout: creates the Order in payment_processing with NO StockHold and NO VES fields, and returns a paypal.approveUrl', async () => {
    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: DBS_UNION_FORCE_ID, quantity: 2 })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send(paypalPickupBody())
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;

    try {
      if (body.status !== 'payment_processing') {
        throw new Error(`Expected payment_processing, got: ${body.status}`);
      }
      if (body.fxRateVesPerUsd !== null || body.totalVes !== null) {
        throw new Error(
          `Expected null FX/VES fields for a paypal checkout, got: fxRateVesPerUsd=${body.fxRateVesPerUsd} totalVes=${body.totalVes}`,
        );
      }
      if (body.paymentInstructions !== null) {
        throw new Error(
          `Expected null paymentInstructions for a paypal checkout, got: ${JSON.stringify(body.paymentInstructions)}`,
        );
      }
      if (!body.paypal?.paypalOrderId || !body.paypal.approveUrl) {
        throw new Error(
          `Expected a paypal session, got: ${JSON.stringify(body.paypal)}`,
        );
      }

      // --- Real DB verification.
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: body.orderId },
        include: { stockHolds: true, statusHistory: true },
      });
      if (order.status !== 'PAYMENT_PROCESSING') {
        throw new Error(`Expected PAYMENT_PROCESSING, got ${order.status}`);
      }
      if (order.paymentRail !== 'PAYPAL') {
        throw new Error(`Expected PAYPAL, got ${order.paymentRail}`);
      }
      if (order.fxRateVesPerUsd !== null || order.totalVes !== null) {
        throw new Error(
          'Expected null fxRateVesPerUsd/totalVes on the persisted Order',
        );
      }
      if (order.paypalOrderId !== body.paypal.paypalOrderId) {
        throw new Error('Expected Order.paypalOrderId to match the response');
      }
      // AD-13: a paypal Order NEVER holds stock.
      if (order.stockHolds.length !== 0) {
        throw new Error(
          `Expected zero StockHold rows, got: ${JSON.stringify(order.stockHolds)}`,
        );
      }
      if (
        order.statusHistory.length !== 1 ||
        order.statusHistory[0].fromStatus !== null ||
        order.statusHistory[0].toStatus !== 'PAYMENT_PROCESSING' ||
        order.statusHistory[0].actorType !== 'SYSTEM'
      ) {
        throw new Error(
          `Unexpected OrderStatusHistory: ${JSON.stringify(order.statusHistory)}`,
        );
      }

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      if (product.heldQty !== 0 || product.stock !== 50) {
        throw new Error(
          `Expected untouched stock/heldQty (paypal never holds), got stock=${product.stock} heldQty=${product.heldQty}`,
        );
      }
    } finally {
      await restoreStockAndDeleteOrder(body.orderId);
    }
  });

  it('webhook confirms payment: transitions payment_processing->paid and atomically decrements stock by exactly the ordered quantity', async () => {
    const { orderId, paypalOrderId } = await checkoutPaypal(
      DBS_UNION_FORCE_ID,
      3,
    );

    try {
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });

      const webhookRes = await postWebhook(paypalOrderId);
      if (webhookRes.status !== 200) {
        throw new Error(
          `Expected 200, got ${webhookRes.status}: ${JSON.stringify(webhookRes.body)}`,
        );
      }
      const ack = webhookRes.body as WebhookAckResponse;
      if (ack.outcome !== 'paid') {
        throw new Error(`Expected outcome=paid, got: ${JSON.stringify(ack)}`);
      }

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
      if (order.status !== 'PAID') {
        throw new Error(`Expected PAID, got ${order.status}`);
      }
      if (order.statusHistory.length !== 2) {
        throw new Error(
          `Expected exactly 2 OrderStatusHistory rows, got: ${JSON.stringify(order.statusHistory)}`,
        );
      }
      const paidRow = order.statusHistory[1];
      if (
        paidRow.fromStatus !== 'PAYMENT_PROCESSING' ||
        paidRow.toStatus !== 'PAID' ||
        paidRow.actorType !== 'PAYPAL_WEBHOOK'
      ) {
        throw new Error(
          `Unexpected paid transition row: ${JSON.stringify(paidRow)}`,
        );
      }

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      if (after.stock !== before.stock - 3) {
        throw new Error(
          `Expected stock to decrement by exactly 3, was ${before.stock}, now ${after.stock}`,
        );
      }
      if (after.heldQty !== before.heldQty) {
        throw new Error('heldQty must never change for a paypal Order');
      }
    } finally {
      await restoreStockAndDeleteOrder(orderId, [
        { productId: DBS_UNION_FORCE_ID, qty: 3 },
      ]);
    }
  });

  it('duplicate webhook confirmation on an already-PAID Order is a safe 200 no-op — never a second stock decrement', async () => {
    const { orderId, paypalOrderId } = await checkoutPaypal(
      DBS_UNION_FORCE_ID,
      1,
    );

    try {
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });

      const firstRes = await postWebhook(paypalOrderId);
      if (firstRes.status !== 200) {
        throw new Error(
          `Expected 200 on the first confirmation, got ${firstRes.status}: ${JSON.stringify(firstRes.body)}`,
        );
      }
      const firstAck = firstRes.body as WebhookAckResponse;
      if (firstAck.outcome !== 'paid') {
        throw new Error(
          `Expected first confirmation outcome=paid, got: ${JSON.stringify(firstAck)}`,
        );
      }

      const afterFirst = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      if (afterFirst.stock !== before.stock - 1) {
        throw new Error(
          'Expected stock to decrement by exactly 1 after the first confirmation',
        );
      }

      // --- The duplicate: same paypalOrderId, second delivery (PayPal
      // retries webhooks that don't behave — this must be a clean 200, not
      // a 409/500).
      const secondRes = await postWebhook(paypalOrderId);
      if (secondRes.status !== 200) {
        throw new Error(
          `Expected 200 on a duplicate webhook, got ${secondRes.status}: ${JSON.stringify(secondRes.body)}`,
        );
      }
      const secondAck = secondRes.body as WebhookAckResponse;
      if (secondAck.outcome !== 'noop') {
        throw new Error(
          `Expected outcome=noop on the duplicate, got: ${JSON.stringify(secondAck)}`,
        );
      }

      const afterSecond = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      if (afterSecond.stock !== afterFirst.stock) {
        throw new Error(
          `Expected stock unchanged by the duplicate confirmation, was ${afterFirst.stock}, now ${afterSecond.stock}`,
        );
      }

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true },
      });
      if (order.status !== 'PAID') {
        throw new Error(
          `Expected the Order to remain PAID, got ${order.status}`,
        );
      }
      // The duplicate must never have written a second history row.
      if (order.statusHistory.length !== 2) {
        throw new Error(
          `Expected exactly 2 OrderStatusHistory rows (no row from the duplicate), got: ${JSON.stringify(order.statusHistory)}`,
        );
      }
    } finally {
      await restoreStockAndDeleteOrder(orderId, [
        { productId: DBS_UNION_FORCE_ID, qty: 1 },
      ]);
    }
  });

  it('PayPal-reported failure transitions payment_processing->payment_failed and NEVER decrements stock', async () => {
    const { orderId, paypalOrderId } = await checkoutPaypal(
      DBS_UNION_FORCE_ID,
      2,
    );

    try {
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });

      // Scripts the fake client to report a declined payment the next time
      // it's asked — simulates PayPal itself reporting failure, never a
      // client-supplied flag.
      fakePaypalClient.setOutcome(paypalOrderId, 'DECLINED');

      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/paypal/webhook')
        .send({ paypalOrderId, eventType: 'PAYMENT.CAPTURE.DENIED' })
        .expect(200);
      const ack = res.body as WebhookAckResponse;
      if (ack.outcome !== 'payment_failed') {
        throw new Error(
          `Expected outcome=payment_failed, got: ${JSON.stringify(ack)}`,
        );
      }

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
      if (order.status !== 'PAYMENT_FAILED') {
        throw new Error(`Expected PAYMENT_FAILED, got ${order.status}`);
      }
      const failedRow = order.statusHistory[1];
      if (
        !failedRow ||
        failedRow.fromStatus !== 'PAYMENT_PROCESSING' ||
        failedRow.toStatus !== 'PAYMENT_FAILED' ||
        failedRow.actorType !== 'PAYPAL_WEBHOOK'
      ) {
        throw new Error(
          `Unexpected failed transition row: ${JSON.stringify(failedRow)}`,
        );
      }

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: DBS_UNION_FORCE_ID },
      });
      if (after.stock !== before.stock) {
        throw new Error(
          `Expected stock untouched on a failed payment, was ${before.stock}, now ${after.stock}`,
        );
      }
    } finally {
      // Never decremented — nothing to restore beyond deleting the Order.
      await restoreStockAndDeleteOrder(orderId);
    }
  });

  it('unknown paypalOrderId: 404 errorCode PAYPAL_ORDER_NOT_FOUND, no Order touched', () => {
    return request(app.getHttpServer())
      .post('/api/v1/payments/paypal/webhook')
      .send({ paypalOrderId: 'no-such-paypal-order-id' })
      .expect(404)
      .expect((res) => {
        const body = res.body as ApiErrorBody;
        if (body.errorCode !== 'PAYPAL_ORDER_NOT_FOUND') {
          throw new Error(
            `Expected errorCode PAYPAL_ORDER_NOT_FOUND, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('concurrency guard: two simultaneous confirmations for the SAME Order resolve to exactly one paid + one noop, and stock is decremented exactly once (never double-decremented)', async () => {
    const { orderId, paypalOrderId } = await checkoutPaypal(
      MTG_PLANESWALKER_ID,
      5,
    );

    try {
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: MTG_PLANESWALKER_ID },
      });

      const [resA, resB] = await Promise.all([
        postWebhook(paypalOrderId),
        postWebhook(paypalOrderId),
      ]);

      const outcomes = [
        resA.body as WebhookAckResponse,
        resB.body as WebhookAckResponse,
      ]
        .map((b) => b.outcome)
        .sort();
      if (outcomes[0] !== 'noop' || outcomes[1] !== 'paid') {
        throw new Error(
          `Expected exactly one "paid" and one "noop", got: ${JSON.stringify([resA.body, resB.body])}`,
        );
      }
      if (resA.status !== 200 || resB.status !== 200) {
        throw new Error(
          `Expected both concurrent confirmations to return 200, got: ${resA.status}, ${resB.status}`,
        );
      }

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true },
      });
      if (order.status !== 'PAID') {
        throw new Error(`Expected PAID, got ${order.status}`);
      }
      // Exactly one paid transition row was ever written — the loser never
      // wrote a second one.
      const paidRows = order.statusHistory.filter((h) => h.toStatus === 'PAID');
      if (paidRows.length !== 1) {
        throw new Error(
          `Expected exactly 1 PAID OrderStatusHistory row, got: ${JSON.stringify(order.statusHistory)}`,
        );
      }

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: MTG_PLANESWALKER_ID },
      });
      if (after.stock !== before.stock - 5) {
        throw new Error(
          `Expected stock to decrement by EXACTLY 5 (not 10, not 0), was ${before.stock}, now ${after.stock}`,
        );
      }
    } finally {
      await restoreStockAndDeleteOrder(orderId, [
        { productId: MTG_PLANESWALKER_ID, qty: 5 },
      ]);
    }
  });
});
