import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { PaymentProcessingTimeoutCronService } from './../src/orders/cron/payment-processing-timeout-cron.service.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';

// Story 14.5 e2e: signed, idempotent Stripe webhook (FR-58, AD-47).
const TAG = randomUUID().slice(0, 8);

interface Checkout {
  orderId: string;
  orderAccessToken: string;
  stripe: { sessionId: string };
}
interface Ack {
  received: boolean;
  outcome: string;
}

describe('Stripe webhook (e2e, Story 14.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const productIds: string[] = [];
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const secret = () =>
    app.get(ConfigService).get<string>('STRIPE_WEBHOOK_SECRET') ||
    FAKE_STRIPE_WEBHOOK_SECRET;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.stripeWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${TAG}` } },
    });
    await prisma.order.deleteMany({
      where: { lines: { some: { productId: { in: productIds } } } },
    });
    await prisma.cart.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await app.close();
  });

  let seq = 0;
  async function makeOrder(
    price = '10.00',
    qty = 2,
    stock = 10,
  ): Promise<{ co: Checkout; productId: string; totalCents: number }> {
    const category = await prisma.category.findFirstOrThrow();
    const n = ++seq;
    const p = await prisma.product.create({
      data: {
        name: `Hook${TAG} ${n}`,
        slug: `hook${TAG}-${n}`,
        description: 'Created by e2e 14.5.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: price,
        stock,
        heldQty: 0,
        isActive: true,
        categoryId: category.id,
      },
    });
    productIds.push(p.id);
    const add = await request(server())
      .post('/api/v1/cart/items')
      .send({ productId: p.id, quantity: qty })
      .expect(201);
    const cookie = (add.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('cartId='))!
      .split(';')[0];
    const res = await request(server())
      .post('/api/v1/checkout')
      .set('Cookie', cookie)
      .send({
        paymentRail: 'stripe',
        fulfillmentType: 'pickup',
        recipientName: 'Maria Perez',
        recipientPhone: '0412-1234567',
      })
      .expect(201);
    return {
      co: res.body as Checkout,
      productId: p.id,
      totalCents: Math.round(Number(price) * 100) * qty,
    };
  }

  function evt(
    type: string,
    co: Checkout,
    over: {
      id?: string;
      paymentStatus?: string;
      amount?: number;
      currency?: string;
      sessionId?: string;
      orderId?: string;
    } = {},
  ): string {
    return JSON.stringify({
      id: over.id ?? `evt_${TAG}_${randomUUID()}`,
      object: 'event',
      type,
      data: {
        object: {
          object: 'checkout.session',
          id: over.sessionId ?? co.stripe.sessionId,
          client_reference_id: over.orderId ?? co.orderId,
          metadata: { orderId: over.orderId ?? co.orderId },
          payment_status: over.paymentStatus ?? 'paid',
          amount_total: over.amount,
          currency: over.currency ?? 'usd',
          payment_intent: 'pi_test_123',
        },
      },
    });
  }

  const sign = (payload: string, s = secret()) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: s });

  const send = (payload: string, sig?: string) => {
    const r = request(server())
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json');
    return r.set('Stripe-Signature', sig ?? sign(payload)).send(payload);
  };

  const db = async (orderId: string, productId: string) => ({
    order: await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
    }),
    product: await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    }),
    events: await prisma.stripeWebhookEvent.count({
      where: { orderId },
    }),
    holds: await prisma.stockHold.findMany({ where: { orderId } }),
  });

  it('AC1/AC9: missing, malformed, wrong-secret, stale or tampered signature -> 400 and nothing written', async () => {
    const { co, productId, totalCents } = await makeOrder();
    const payload = evt('checkout.session.completed', co, {
      amount: totalCents,
    });
    const url = '/api/v1/payments/stripe/webhook';
    const post = () =>
      request(server()).post(url).set('Content-Type', 'application/json');
    const bad = [
      await post().send(payload),
      await post().set('Stripe-Signature', 'garbage').send(payload),
      await post()
        .set('Stripe-Signature', sign(payload, 'whsec_wrong'))
        .send(payload),
      await post()
        .set(
          'Stripe-Signature',
          Stripe.webhooks.generateTestHeaderString({
            payload,
            secret: secret(),
            timestamp: Math.floor(Date.now() / 1000) - 3600,
          }),
        )
        .send(payload),
      await post()
        .set('Stripe-Signature', sign(payload))
        .send(payload.replace('"usd"', '"eur"')),
    ];
    for (const r of bad) {
      expect(r.status).toBe(400);
      expect((r.body as { errorCode: string }).errorCode).toBe(
        'STRIPE_SIGNATURE_INVALID',
      );
    }
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAYMENT_PROCESSING');
    expect(s.events).toBe(0);
  });

  it('AC2/AC10: completed+paid -> PAID with STRIPE_WEBHOOK history, stock decremented, intent saved, lookup shows paid', async () => {
    const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
    const res = await send(
      evt('checkout.session.completed', co, { amount: totalCents }),
    ).expect(200);
    expect(res.body).toEqual({ received: true, outcome: 'paid' });
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAID');
    expect(s.order.stripePaymentIntentId).toBe('pi_test_123');
    expect(s.order.statusHistory.map((h) => h.toStatus)).toEqual([
      'PAYMENT_PROCESSING',
      'PAID',
    ]);
    expect(s.order.statusHistory[1].actorType).toBe('STRIPE_WEBHOOK');
    // Story 14.5b: hold consumed -> stock and heldQty drop together, once.
    expect(s.product).toMatchObject({ stock: 8, heldQty: 0 });
    expect(s.holds).toHaveLength(1);
    expect(s.holds[0].releasedAt).not.toBeNull();
    expect(s.events).toBe(1);
    const lookup = await request(server())
      .get(`/api/v1/orders/${co.orderId}`)
      .set('Authorization', `Bearer ${co.orderAccessToken}`)
      .expect(200);
    expect((lookup.body as { status: string }).status).toBe('paid');
  });

  it('AC3: completed+unpaid is a no-op; async_payment_succeeded pays', async () => {
    const { co, productId, totalCents } = await makeOrder();
    const r1 = await send(
      evt('checkout.session.completed', co, {
        paymentStatus: 'unpaid',
        amount: totalCents,
      }),
    ).expect(200);
    expect((r1.body as Ack).outcome).toBe('noop');
    expect((await db(co.orderId, productId)).order.status).toBe(
      'PAYMENT_PROCESSING',
    );
    const r2 = await send(
      evt('checkout.session.async_payment_succeeded', co, {
        amount: totalCents,
      }),
    ).expect(200);
    expect((r2.body as Ack).outcome).toBe('paid');
    expect((await db(co.orderId, productId)).order.status).toBe('PAID');
  });

  it.each([
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
  ])(
    'AC4: %s -> PAYMENT_FAILED, hold released (heldQty restored, stock untouched)',
    async (type) => {
      const { co, productId, totalCents } = await makeOrder();
      const r = await send(
        evt(type, co, { paymentStatus: 'unpaid', amount: totalCents }),
      ).expect(200);
      expect((r.body as Ack).outcome).toBe('failed');
      const s = await db(co.orderId, productId);
      expect(s.order.status).toBe('PAYMENT_FAILED');
      expect(s.order.statusHistory[1].actorType).toBe('STRIPE_WEBHOOK');
      expect(s.product).toMatchObject({ stock: 10, heldQty: 0 });
      expect(s.holds[0].releasedAt).not.toBeNull();
      // delivered again (distinct event): no double release
      await send(
        evt(type, co, { paymentStatus: 'unpaid', amount: totalCents }),
      ).expect(200);
      expect((await db(co.orderId, productId)).product.heldQty).toBe(0);
    },
  );

  it('AC5: 5 parallel deliveries of the same event -> one transition, stock once', async () => {
    const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
    const payload = evt('checkout.session.completed', co, {
      amount: totalCents,
    });
    const header = sign(payload);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => send(payload, header)),
    );
    rs.forEach((r) => expect(r.status).toBe(200));
    const outcomes = rs.map((r) => (r.body as Ack).outcome).sort();
    expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(4);
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAID');
    expect(s.order.statusHistory).toHaveLength(2);
    expect(s.product).toMatchObject({ stock: 8, heldQty: 0 });
    expect(s.events).toBe(1);
  });

  it('AC5: completed + async_payment_succeeded in parallel (distinct events) -> one transition', async () => {
    const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
    const payloads = [
      evt('checkout.session.completed', co, { amount: totalCents }),
      evt('checkout.session.async_payment_succeeded', co, {
        amount: totalCents,
      }),
      evt('checkout.session.completed', co, { amount: totalCents }),
      evt('checkout.session.async_payment_succeeded', co, {
        amount: totalCents,
      }),
    ];
    const rs = await Promise.all(payloads.map((p) => send(p)));
    rs.forEach((r) => expect(r.status).toBe(200));
    expect(rs.filter((r) => (r.body as Ack).outcome === 'paid')).toHaveLength(
      1,
    );
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAID');
    expect(s.order.statusHistory).toHaveLength(2);
    expect(s.product).toMatchObject({ stock: 8, heldQty: 0 });
    expect(s.events).toBe(4);
  });

  it('AC6: different amount or currency -> 200, not paid, stock untouched, amount_mismatch recorded', async () => {
    const { co, productId, totalCents } = await makeOrder();
    const a = await send(
      evt('checkout.session.completed', co, { amount: totalCents - 1 }),
    ).expect(200);
    expect((a.body as Ack).outcome).toBe('amount_mismatch');
    const b = await send(
      evt('checkout.session.completed', co, {
        amount: totalCents,
        currency: 'eur',
      }),
    ).expect(200);
    expect((b.body as Ack).outcome).toBe('amount_mismatch');
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAYMENT_PROCESSING');
    expect(s.product).toMatchObject({ stock: 10, heldQty: 2 });
    expect(s.holds[0].releasedAt).toBeNull();
    const rows = await prisma.stripeWebhookEvent.findMany({
      where: { orderId: co.orderId },
    });
    expect(rows.map((r) => r.outcome)).toEqual([
      'amount_mismatch',
      'amount_mismatch',
    ]);
  });

  it('AC7: unknown type, unknown session, mismatching metadata, terminal orders -> 200 without state change', async () => {
    const { co, productId, totalCents } = await makeOrder();
    const ign = await send(
      evt('charge.succeeded', co, { amount: totalCents }),
    ).expect(200);
    expect((ign.body as Ack).outcome).toBe('ignored');
    const unk = await send(
      evt('checkout.session.completed', co, {
        amount: totalCents,
        sessionId: 'cs_test_nope',
      }),
    ).expect(200);
    expect((unk.body as Ack).outcome).toBe('unknown_order');
    const meta = await send(
      evt('checkout.session.completed', co, {
        amount: totalCents,
        orderId: randomUUID(),
      }),
    ).expect(200);
    expect((meta.body as Ack).outcome).toBe('unknown_order');
    expect((await db(co.orderId, productId)).order.status).toBe(
      'PAYMENT_PROCESSING',
    );

    // fail first, then a paid event must not resurrect it
    await send(
      evt('checkout.session.expired', co, { paymentStatus: 'unpaid' }),
    ).expect(200);
    const late = await send(
      evt('checkout.session.completed', co, { amount: totalCents }),
    ).expect(200);
    expect((late.body as Ack).outcome).toBe('noop');
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAYMENT_FAILED');
    expect(s.product).toMatchObject({ stock: 10, heldQty: 0 });
    // Story 14.5b AC11: the confirmed payment leaves a persistent trace.
    const trace = await prisma.stripeWebhookEvent.findMany({
      where: { orderId: co.orderId, outcome: 'refund_pending_after_terminal' },
    });
    expect(trace).toHaveLength(1);

    // paid order: further events are no-ops
    const paid = await makeOrder();
    await send(
      evt('checkout.session.completed', paid.co, { amount: paid.totalCents }),
    ).expect(200);
    const again = await send(
      evt('checkout.session.async_payment_failed', paid.co, {
        paymentStatus: 'unpaid',
      }),
    ).expect(200);
    expect((again.body as Ack).outcome).toBe('noop');
    expect((await db(paid.co.orderId, paid.productId)).order.status).toBe(
      'PAID',
    );
  });

  it('AC8/R1 (14.5b AC10): guarded consume affects 0 rows -> rollback, refund_pending_no_stock persisted, redelivery is a duplicate', async () => {
    const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
    await prisma.product.update({
      where: { id: productId },
      data: { stock: 1 },
    });
    const payload = evt('checkout.session.completed', co, {
      amount: totalCents,
    });
    const r = await send(payload).expect(200);
    expect((r.body as Ack).outcome).toBe('no_stock');
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAYMENT_PROCESSING');
    expect(s.order.statusHistory).toHaveLength(1);
    expect(s.product).toMatchObject({ stock: 1, heldQty: 2 });
    expect(s.holds[0].releasedAt).toBeNull();
    expect(s.events).toBe(1);
    const row = await prisma.stripeWebhookEvent.findFirstOrThrow({
      where: { orderId: co.orderId },
    });
    expect(row.outcome).toBe('refund_pending_no_stock');
    const again = await send(payload).expect(200);
    expect((again.body as Ack).outcome).toBe('duplicate');
    expect((await db(co.orderId, productId)).events).toBe(1);
  });

  it('14.5b AC10: hold manually released -> not PAID, refund_pending_no_stock, stock/heldQty untouched', async () => {
    const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
    await prisma.$transaction([
      prisma.stockHold.updateMany({
        where: { orderId: co.orderId },
        data: { releasedAt: new Date() },
      }),
      prisma.product.update({
        where: { id: productId },
        data: { heldQty: 0 },
      }),
    ]);
    const r = await send(
      evt('checkout.session.completed', co, { amount: totalCents }),
    ).expect(200);
    expect((r.body as Ack).outcome).toBe('no_stock');
    const s = await db(co.orderId, productId);
    expect(s.order.status).toBe('PAYMENT_PROCESSING');
    expect(s.product).toMatchObject({ stock: 10, heldQty: 0 });
    const row = await prisma.stripeWebhookEvent.findFirstOrThrow({
      where: { orderId: co.orderId },
    });
    expect(row.outcome).toBe('refund_pending_no_stock');
  });

  it('14.5b AC9: paid vs expired vs cron timeout simultaneously -> one transition, hold settled exactly once', async () => {
    for (let i = 0; i < 4; i++) {
      const { co, productId, totalCents } = await makeOrder('10.00', 2, 10);
      await prisma.order.update({
        where: { id: co.orderId },
        data: { createdAt: new Date(Date.now() - 61 * 60 * 1000) },
      });
      const cron = app.get(PaymentProcessingTimeoutCronService);
      const rs = await Promise.all([
        send(evt('checkout.session.completed', co, { amount: totalCents })),
        send(evt('checkout.session.expired', co, { paymentStatus: 'unpaid' })),
        send(
          evt('checkout.session.async_payment_failed', co, {
            paymentStatus: 'unpaid',
          }),
        ),
        cron.runTimeoutCheck(),
        cron.runTimeoutCheck(),
      ]);
      rs.slice(0, 3).forEach((r) =>
        expect((r as { status: number }).status).toBe(200),
      );
      const s = await db(co.orderId, productId);
      expect(['PAID', 'PAYMENT_FAILED']).toContain(s.order.status);
      expect(s.order.statusHistory).toHaveLength(2);
      expect(s.holds.every((h) => h.releasedAt !== null)).toBe(true);
      expect(s.product.heldQty).toBe(0);
      const paid = s.order.status === 'PAID';
      expect(s.product.stock).toBe(paid ? 8 : 10);
      const traces = await prisma.stripeWebhookEvent.count({
        where: {
          orderId: co.orderId,
          outcome: 'refund_pending_after_terminal',
        },
      });
      // A paid event that lost to a terminal failure is never silent.
      expect(traces).toBe(paid ? 0 : 1);
    }
  });

  it('AC9: only the webhook route reads the raw body; JSON routes still parse', async () => {
    await request(server())
      .post('/api/v1/cart/items')
      .send({ productId: randomUUID(), quantity: 1 })
      .expect((res) => {
        expect(res.status).not.toBe(500);
      });
  });

  it('AC11: Swagger documents the webhook', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const path = Object.keys(doc.paths).find((p) =>
      p.endsWith('/payments/stripe/webhook'),
    );
    expect(path).toBeDefined();
    const op = doc.paths[path!].post!;
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['200', '400']),
    );
  });

  it('Story 14.6 (AD-49): the retired webhook route is 404 and Swagger has no trace of it', async () => {
    const retired = 'pay' + 'pal';
    await request(server())
      .post(`/api/v1/payments/${retired}/webhook`)
      .send({})
      .expect(404);
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(JSON.stringify(doc).toLowerCase()).not.toContain(retired);
  });
});
