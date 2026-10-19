import { randomUUID } from 'node:crypto';
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
import { PaymentProcessingTimeoutCronService } from './../src/orders/cron/payment-processing-timeout-cron.service.js';
import { StockHoldExpiryCronService } from './../src/orders/cron/stock-hold-expiry-cron.service.js';
import { FakeStripeClient } from './../src/payments-stripe/fake-stripe-client.js';

// Story 14.4 e2e: checkout with paymentRail=stripe (FR-57, AD-46, AD-44).
const TAG = randomUUID().slice(0, 8);
const PASSWORD = 'correct-horse-battery-14-4';
const ADMIN_USERNAME = `e2e-admin-14-4-${TAG}`;
const ADMIN_PASSWORD = 'correct-horse-battery-staple-14-4';

interface StripeCheckoutBody {
  orderId: string;
  status: string;
  totalUsd: number;
  fxRateVesPerUsd: number | null;
  totalVes: number | null;
  lines: unknown[];
  paymentInstructions: unknown;
  stripe: { sessionId: string; url: string } | null;
  orderAccessToken: string;
}

const body = (over: Record<string, unknown> = {}) => ({
  paymentRail: 'stripe',
  fulfillmentType: 'pickup',
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
  ...over,
});

describe('Stripe checkout (e2e, Story 14.4)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fake: FakeStripeClient;
  let adminId: string;
  let adminToken: string;
  const productIds: string[] = [];
  const emails: string[] = [];
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

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
    fake = app.get(FakeStripeClient);

    const admin = await prisma.adminUser.create({
      data: {
        username: ADMIN_USERNAME,
        email: `${ADMIN_USERNAME}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
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
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cookieHeader = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  async function makeProduct(
    key: string,
    priceUsd: string,
    stock = 20,
    name?: string,
  ): Promise<string> {
    const category = await prisma.category.findFirstOrThrow();
    const p = await prisma.product.create({
      data: {
        name: name ?? `Stripe${TAG} ${key}`,
        slug: `stripe${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 14.4.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd,
        stock,
        heldQty: 0,
        isActive: true,
        categoryId: category.id,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  async function guestCart(
    items: Array<{ productId: string; quantity: number }>,
  ): Promise<string> {
    let cookie = '';
    for (const it of items) {
      const req = request(server()).post('/api/v1/cart/items');
      if (cookie) void req.set('Cookie', cookie);
      const res = await req.send(it).expect(201);
      cookie = cookieHeader(res, 'cartId') || cookie;
    }
    return cookie;
  }

  const guestCheckout = (cookie: string, over: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/checkout')
      .set('Cookie', cookie)
      .send(body(over));

  it('AC1/AC2/AC4: guest checkout creates a PAYMENT_PROCESSING order with one 65-min hold per line (14.5b), session args computed server-side, success lookup stays payment_processing', async () => {
    const p1 = await makeProduct(
      'a',
      '19.99',
      20,
      'Charizard ' + 'X'.repeat(300),
    );
    const p2 = await makeProduct('b', '0.10');
    const cookie = await guestCart([
      { productId: p1, quantity: 3 },
      { productId: p2, quantity: 7 },
    ]);
    const before = Date.now();

    const res = await guestCheckout(cookie, {
      // hostile extras must be rejected or ignored, never used for the amount
    }).expect(201);
    const out = res.body as StripeCheckoutBody;

    expect(out.status).toBe('payment_processing');
    expect(out.paymentInstructions).toBeNull();
    expect(out).not.toHaveProperty('pay' + 'pal');
    expect(out.fxRateVesPerUsd).toBeNull();
    expect(out.totalVes).toBeNull();
    expect(out.stripe?.sessionId).toMatch(/^cs_test_fake_/);
    expect(out.stripe?.url).toContain('https://stripe.fake/checkout/');
    expect(out.totalUsd).toBe(60.67);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: out.orderId },
      include: { statusHistory: true, stockHolds: true, lines: true },
    });
    expect(order.paymentRail).toBe('STRIPE');
    expect(order.status).toBe('PAYMENT_PROCESSING');
    expect(order.stockHolds).toHaveLength(2);
    for (const hold of order.stockHolds) {
      expect(hold.releasedAt).toBeNull();
      const ttl = hold.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(64 * 60 * 1000);
      expect(ttl).toBeLessThan(66 * 60 * 1000);
    }
    expect(order.fxRateVesPerUsd).toBeNull();
    expect(order.totalVes).toBeNull();
    expect(order.customerId).toBeNull();
    expect(order.stripeCheckoutSessionId).toBe(out.stripe?.sessionId);
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'PAYMENT_PROCESSING',
      actorType: 'SYSTEM',
    });
    const prod = await prisma.product.findUniqueOrThrow({ where: { id: p1 } });
    expect(prod.heldQty).toBe(3);
    expect(prod.stock).toBe(20);

    const call = fake.createdSessions.find(
      (s) => s.sessionId === out.stripe?.sessionId,
    );
    if (!call) throw new Error('session args not recorded');
    expect(call.orderId).toBe(out.orderId);
    expect(call.currency).toBe('usd');
    expect(call.lines).toHaveLength(2);
    const sum = call.lines.reduce(
      (a, l) => a + l.unitAmountCents * l.quantity,
      0,
    );
    expect(sum).toBe(Math.round(out.totalUsd * 100));
    expect(sum).toBe(6067);
    expect(call.lines[0].name.length).toBeLessThanOrEqual(250);
    const frontend = app
      .get(ConfigService)
      .get<string>('FRONTEND_URL', 'http://localhost:3000');
    expect(call.successUrl).toBe(
      `${frontend}/checkout/success?orderId=${out.orderId}`,
    );
    expect(call.cancelUrl).toBe(
      `${frontend}/checkout/cancel?orderId=${out.orderId}`,
    );
    const ttl = call.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * 60 * 1000 - 1000);
    expect(ttl).toBeLessThan(30 * 60 * 1000 + 15000);

    // AC4: arriving at success_url pays nothing - lookup still processing.
    const lookup = await request(server())
      .get(`/api/v1/orders/${out.orderId}`)
      .set('Authorization', `Bearer ${out.orderAccessToken}`)
      .expect(200);
    expect(lookup.body).toMatchObject({
      status: 'payment_processing',
      paymentRail: 'stripe',
    });
  });

  it('AC2: the client cannot influence the amount (extra amount/price fields are stripped, DB price is charged)', async () => {
    const p = await makeProduct('c', '12.50');
    const cookie = await guestCart([{ productId: p, quantity: 1 }]);
    const ok = await guestCheckout(cookie, {
      totalUsd: 0.01,
      amount: 1,
      unitAmountCents: 1,
      lines: [{ productId: p, unitPriceUsd: 0.01, quantity: 1 }],
    }).expect(201);
    const created = fake.createdSessions.at(-1);
    expect(created?.lines).toEqual([
      {
        name: expect.any(String) as unknown,
        unitAmountCents: 1250,
        quantity: 1,
      },
    ]);
    expect((ok.body as StripeCheckoutBody).totalUsd).toBe(12.5);
  });

  it('AC1: checkout with a customer account links customerId and prefills the customer email', async () => {
    const p = await makeProduct('d', '5.00');
    const email = `e2e-14-4-${TAG}@212collectorsclub.test`;
    emails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Acc Tester' })
      .expect(201);
    const c = await prisma.customer.update({
      where: { email },
      data: { emailVerified: true },
    });
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const s = cookieHeader(login, 'cc_session');
    await request(server())
      .post('/api/v1/cart/items')
      .set('Cookie', s)
      .send({ productId: p, quantity: 2 })
      .expect(201);
    const res = await request(server())
      .post('/api/v1/checkout')
      .set('Cookie', s)
      .send(body())
      .expect(201);
    const out = res.body as StripeCheckoutBody;
    expect(out.stripe).not.toBeNull();
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: out.orderId },
    });
    expect(order.customerId).toBe(c.id);
    expect(fake.createdSessions.at(-1)?.customerEmail).toBe(email);
  });

  it('AC3: Stripe failure -> 502 STRIPE_SESSION_CREATION_FAILED, order PAYMENT_FAILED (SYSTEM history), hold released in the same tx (14.5b), stock untouched, no session id', async () => {
    const p = await makeProduct('e', '8.00', 10);
    const cookie = await guestCart([{ productId: p, quantity: 2 }]);
    vi.spyOn(fake, 'createCheckoutSession').mockRejectedValueOnce(
      new Error('stripe down'),
    );

    const res = await guestCheckout(cookie).expect(502);
    expect((res.body as { errorCode: string }).errorCode).toBe(
      'STRIPE_SESSION_CREATION_FAILED',
    );

    const orders = await prisma.order.findMany({
      where: { lines: { some: { productId: p } } },
      include: {
        statusHistory: { orderBy: { createdAt: 'asc' } },
        stockHolds: true,
      },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('PAYMENT_FAILED');
    expect(orders[0].stripeCheckoutSessionId).toBeNull();
    expect(orders[0].stockHolds).toHaveLength(1);
    expect(orders[0].stockHolds[0].releasedAt).not.toBeNull();
    expect(orders[0].statusHistory.map((h) => h.toStatus)).toEqual([
      'PAYMENT_PROCESSING',
      'PAYMENT_FAILED',
    ]);
    expect(orders[0].statusHistory[1].actorType).toBe('SYSTEM');
    const prod = await prisma.product.findUniqueOrThrow({ where: { id: p } });
    expect(prod).toMatchObject({ stock: 10, heldQty: 0 });
  });

  it('AC1: insufficient stock returns 409 INSUFFICIENT_STOCK and creates no order/session', async () => {
    const p = await makeProduct('f', '3.00', 1);
    const cookie = await guestCart([{ productId: p, quantity: 1 }]);
    await prisma.product.update({ where: { id: p }, data: { stock: 0 } });
    const sessionsBefore = fake.createdSessions.length;
    const res = await guestCheckout(cookie).expect(409);
    expect((res.body as { errorCode: string }).errorCode).toBe(
      'INSUFFICIENT_STOCK',
    );
    expect(fake.createdSessions).toHaveLength(sessionsBefore);
  });

  it('AC8: invalid or injected paymentRail still 400s', async () => {
    const p = await makeProduct('g', '3.00');
    const cookie = await guestCart([{ productId: p, quantity: 1 }]);
    for (const rail of ['STRIPE', 'stripe; DROP TABLE', 'card', '']) {
      await guestCheckout(cookie, { paymentRail: rail }).expect(400);
    }
  });

  it('AC5: admin list filters paymentRail=stripe; proof upload and Pago Movil confirm/reject reject a Stripe order', async () => {
    const p = await makeProduct('h', '4.00');
    const cookie = await guestCart([{ productId: p, quantity: 1 }]);
    const out = (await guestCheckout(cookie).expect(201))
      .body as StripeCheckoutBody;

    const list = await request(server())
      .get('/api/v1/admin/orders?paymentRail=stripe&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const items = list.body as {
      items?: Array<{ orderId: string; paymentRail: string }>;
      data?: Array<{ orderId: string; paymentRail: string }>;
    };
    const rows = items.items ?? items.data ?? [];
    expect(rows.every((r) => r.paymentRail === 'stripe')).toBe(true);

    await request(server())
      .post(`/api/v1/orders/${out.orderId}/proof-of-payment`)
      .set('Authorization', `Bearer ${out.orderAccessToken}`)
      .attach('file', Buffer.from('fake-png-bytes-for-testing'), {
        filename: 'p.png',
        contentType: 'image/png',
      })
      .expect(409);
    expect(
      await prisma.proofOfPayment.count({ where: { orderId: out.orderId } }),
    ).toBe(0);

    for (const action of ['confirm-payment', 'reject-payment']) {
      await request(server())
        .post(`/api/v1/admin/orders/${out.orderId}/${action}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(409);
    }
    const after = await prisma.order.findUniqueOrThrow({
      where: { id: out.orderId },
    });
    expect(after.status).toBe('PAYMENT_PROCESSING');
  });

  // ---------------------------------------------------------------- 14.5b
  const pmBody = {
    paymentRail: 'pago_movil',
    fulfillmentType: 'pickup',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
  };

  it('14.5b AC2: 6 parallel Stripe checkouts for the last unit -> exactly one 201 with hold, rest 409, no order/session, heldQty 1', async () => {
    const p = await makeProduct('last', '5.00', 1);
    const cookies = await Promise.all(
      Array.from({ length: 6 }, () =>
        guestCart([{ productId: p, quantity: 1 }]),
      ),
    );
    const sessionsBefore = fake.createdSessions.length;
    const rs = await Promise.all(cookies.map((c) => guestCheckout(c)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = rs.filter((r) => r.status === 409);
    expect(losers).toHaveLength(5);
    losers.forEach((r) =>
      expect((r.body as { errorCode: string }).errorCode).toBe(
        'INSUFFICIENT_STOCK',
      ),
    );
    expect(fake.createdSessions.length - sessionsBefore).toBe(1);
    const orders = await prisma.order.findMany({
      where: { lines: { some: { productId: p } } },
      include: { stockHolds: true },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].stockHolds).toHaveLength(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: p } })).heldQty,
    ).toBe(1);
  });

  it('14.5b AC3: Pago Movil and Stripe racing for the last unit -> only one wins', async () => {
    const p = await makeProduct('race', '5.00', 1);
    const carts = await Promise.all(
      Array.from({ length: 4 }, () =>
        guestCart([{ productId: p, quantity: 1 }]),
      ),
    );
    const rs = await Promise.all(
      carts.map((c, i) =>
        i % 2 === 0
          ? guestCheckout(c)
          : request(server())
              .post('/api/v1/checkout')
              .set('Cookie', c)
              .send(pmBody),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: p } })).heldQty,
    ).toBe(1);
  });

  async function stripeOrderWithHold(key: string, qty = 2) {
    const p = await makeProduct(key, '6.00', 10);
    const cookie = await guestCart([{ productId: p, quantity: qty }]);
    const out = (await guestCheckout(cookie).expect(201))
      .body as StripeCheckoutBody;
    return { p, out };
  }

  it('14.5b AC8: timeout cron (run twice concurrently) fails a 61-min Stripe order and releases the hold once; stock-hold-expiry never touches it', async () => {
    const { p, out } = await stripeOrderWithHold('cron');
    await prisma.stockHold.updateMany({
      where: { orderId: out.orderId },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });
    // stock-hold-expiry ignores PAYMENT_PROCESSING even with expiresAt past
    const expiry = await app.get(StockHoldExpiryCronService).runExpiryCheck();
    expect(expiry.ordersExpired).toBe(0);
    let prod = await prisma.product.findUniqueOrThrow({ where: { id: p } });
    expect(prod.heldQty).toBe(2);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: out.orderId } }))
        .status,
    ).toBe('PAYMENT_PROCESSING');

    await prisma.order.update({
      where: { id: out.orderId },
      data: { createdAt: new Date(Date.now() - 61 * 60 * 1000) },
    });
    const cron = app.get(PaymentProcessingTimeoutCronService);
    await Promise.all([cron.runTimeoutCheck(), cron.runTimeoutCheck()]);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: out.orderId },
      include: { statusHistory: true, stockHolds: true },
    });
    expect(order.status).toBe('PAYMENT_FAILED');
    expect(order.statusHistory).toHaveLength(2);
    expect(order.stockHolds[0].releasedAt).not.toBeNull();
    prod = await prisma.product.findUniqueOrThrow({ where: { id: p } });
    expect(prod).toMatchObject({ stock: 10, heldQty: 0 });
  });

  it('14.5b AC12: admin detail exposes refundPending and the list filters refundPending=true', async () => {
    const a = await stripeOrderWithHold('rp1', 1);
    const b = await stripeOrderWithHold('rp2', 1);
    const evtId = `evt_${TAG}_rp`;
    await prisma.stripeWebhookEvent.create({
      data: {
        eventId: evtId,
        type: 'checkout.session.completed',
        orderId: a.out.orderId,
        outcome: 'refund_pending_after_terminal',
      },
    });
    try {
      const auth = { Authorization: `Bearer ${adminToken}` };
      const da = await request(server())
        .get(`/api/v1/admin/orders/${a.out.orderId}`)
        .set(auth)
        .expect(200);
      expect((da.body as { refundPending: boolean }).refundPending).toBe(true);
      expect((da.body as { orderId: string }).orderId).toBe(a.out.orderId);
      const db_ = await request(server())
        .get(`/api/v1/admin/orders/${b.out.orderId}`)
        .set(auth)
        .expect(200);
      expect((db_.body as { refundPending: boolean }).refundPending).toBe(
        false,
      );
      await request(server())
        .get(`/api/v1/admin/orders/${randomUUID()}`)
        .set(auth)
        .expect(404);

      const list = await request(server())
        .get('/api/v1/admin/orders?refundPending=true&limit=100')
        .set(auth)
        .expect(200);
      const rows = (
        list.body as {
          data: Array<{ orderId: string; refundPending: boolean }>;
        }
      ).data;
      expect(rows.some((r) => r.orderId === a.out.orderId)).toBe(true);
      expect(rows.some((r) => r.orderId === b.out.orderId)).toBe(false);
      expect(rows.every((r) => r.refundPending)).toBe(true);
      await request(server())
        .get('/api/v1/admin/orders?refundPending=banana')
        .set(auth)
        .expect(400);

      const { SwaggerModule, DocumentBuilder } =
        await import('@nestjs/swagger');
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const listPath = Object.keys(doc.paths).find((x) =>
        x.endsWith('/admin/orders'),
      );
      const params = (doc.paths[listPath!].get!.parameters ?? []) as Array<{
        name: string;
      }>;
      expect(params.map((x) => x.name)).toContain('refundPending');
      expect(
        Object.keys(doc.paths).some((x) =>
          x.endsWith('/admin/orders/{orderId}'),
        ),
      ).toBe(true);
    } finally {
      await prisma.stripeWebhookEvent.delete({ where: { eventId: evtId } });
    }
  });
});
