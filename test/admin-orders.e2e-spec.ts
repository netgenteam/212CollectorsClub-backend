import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';

type App = Parameters<typeof request>[0];

interface AdminOrderListItem {
  orderId: string;
  status: string;
  paymentRail: string;
  fulfillmentType: string;
  recipientName: string;
  totalUsd: number;
  totalVes: number | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedAdminOrders {
  data: AdminOrderListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface CheckoutResponse {
  orderId: string;
  totalUsd: number;
  stripe: { sessionId: string; url: string } | null;
}

interface ApiErrorBody {
  errorCode?: string;
}

const TEST_USERNAME = 'e2e-admin-story-9-1';
const TEST_EMAIL = 'e2e-admin-story-9-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-9f1c';

// Story 1.4 seed Products (prisma/seed.ts), both with ample stock so this
// suite's small quantities never risk INSUFFICIENT_STOCK against whatever
// else is running concurrently against the shared dev Postgres — same
// "ample stock, self-contained cleanup" convention checkout.e2e-spec.ts/
// the stripe e2e suites already use.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180
const DBS_UNION_FORCE_ID = '769f36ae-c8ea-4535-97df-11872d7915cc'; // stock 50

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

function pagoMovilBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'pago_movil',
    fulfillmentType: 'delivery',
    addressLine1: 'Av. Test 1',
    city: 'Caracas',
    state: 'Distrito Capital',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

function stripeBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'stripe',
    fulfillmentType: 'delivery',
    addressLine1: 'Av. Test 1',
    city: 'Caracas',
    state: 'Distrito Capital',
    recipientName: 'Carlos Gomez',
    recipientPhone: '0414-7654321',
    ...overrides,
  };
}

/**
 * Story 9.1 (FR-26, NFR-4; AD-11, AD-14). Full-stack e2e coverage (real
 * AdminAuthGuard, real Postgres) of `GET /api/v1/admin/orders`: no-filter
 * pagination, the `status`/`paymentRail` filters (individually and
 * combined, AND semantics), stable-400 on an out-of-enum value, 401
 * without a token, and default createdAt-desc sorting. Every Order this
 * suite creates goes through a REAL checkout (Pago Móvil stays
 * pending_verification; Stripe is pushed to paid via a signed webhook against
 * the fake Stripe client, since there is no real Stripe in this dev
 * environment) and is cleaned up (stock restored,
 * Order deleted) in a `finally` block, same discipline every other
 * checkout-driving e2e suite in this repo already follows.
 */
describe('AdminOrdersController (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });

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

  function authedGet(query = '') {
    return request(app.getHttpServer())
      .get(`/api/v1/admin/orders${query}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  /** Real Pago Móvil checkout — the resulting Order stays
   * `pending_verification` (no Story 9.2 admin confirm/reject exists yet
   * to move it further), with an active StockHold. */
  async function createPagoMovilOrder(
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
      .send(pagoMovilBody())
      .expect(201);
    return (checkoutRes.body as CheckoutResponse).orderId;
  }

  async function cleanupPagoMovilOrder(orderId: string): Promise<void> {
    const holds = await prisma.stockHold.findMany({
      where: { orderId },
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

  /** Real Stripe checkout, immediately confirmed via a signed webhook
   * (fake Stripe client, since this dev environment has no real Stripe
   * keys) — the resulting Order ends in `paid`. */
  async function createPaidStripeOrder(
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
      .send(stripeBody())
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;
    if (!body.stripe) {
      throw new Error(
        `Expected a stripe session, got: ${JSON.stringify(body)}`,
      );
    }

    const secret =
      app.get(ConfigService).get<string>('STRIPE_WEBHOOK_SECRET') ||
      FAKE_STRIPE_WEBHOOK_SECRET;
    const payload = JSON.stringify({
      id: `evt_admin_orders_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          object: 'checkout.session',
          id: body.stripe.sessionId,
          client_reference_id: body.orderId,
          metadata: { orderId: body.orderId },
          payment_status: 'paid',
          amount_total: Math.round(body.totalUsd * 100),
          currency: 'usd',
          payment_intent: 'pi_test_admin_orders',
        },
      },
    });
    await request(app.getHttpServer())
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      )
      .send(payload)
      .expect(200);

    return body.orderId;
  }

  async function cleanupStripeOrder(
    orderId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await prisma.product.update({
      where: { id: productId },
      data: { stock: { increment: quantity } },
    });
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
  }

  describe('AdminAuthGuard gating', () => {
    it('no token: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });
  });

  describe('malformed query params (NFR-4): stable 400, never 500', () => {
    it('an out-of-enum status value: 400', async () => {
      await authedGet('?status=not_a_real_status').expect(400);
    });

    it('an out-of-enum paymentRail value: 400', async () => {
      await authedGet('?paymentRail=bitcoin').expect(400);
    });

    it('page=0 (below minimum): 400', async () => {
      await authedGet('?page=0').expect(400);
    });

    it('limit beyond the max: 400', async () => {
      await authedGet('?limit=1000').expect(400);
    });
  });

  describe('list/filter over real Orders (AC1-AC3)', () => {
    it('no filters, status=pending_verification, paymentRail=stripe, and the AND combination all behave correctly against 2 real Orders of different rail/status', async () => {
      const pagoMovilOrderId = await createPagoMovilOrder(
        OP_ROMANCE_DAWN_ID,
        1,
      );
      const stripeOrderId = await createPaidStripeOrder(DBS_UNION_FORCE_ID, 1);

      try {
        // --- AC1: no filters -> both appear, each with its own
        // status/paymentRail visible.
        const allRes = await authedGet().expect(200);
        const all = allRes.body as PaginatedAdminOrders;
        const pagoMovilRow = all.data.find(
          (o) => o.orderId === pagoMovilOrderId,
        );
        const stripeRow = all.data.find((o) => o.orderId === stripeOrderId);
        if (!pagoMovilRow || !stripeRow) {
          throw new Error(
            `Expected both test Orders in the unfiltered list, got: ${JSON.stringify(
              all.data.map((o) => o.orderId),
            )}`,
          );
        }
        expect(pagoMovilRow.status).toBe('pending_verification');
        expect(pagoMovilRow.paymentRail).toBe('pago_movil');
        expect(stripeRow.status).toBe('paid');
        expect(stripeRow.paymentRail).toBe('stripe');
        expect(all.meta).toEqual({
          page: expect.any(Number) as number,
          limit: expect.any(Number) as number,
          total: expect.any(Number) as number,
          totalPages: expect.any(Number) as number,
        });

        // --- AC2: status=pending_verification -> only the Pago Móvil
        // Order is present; the paid Stripe Order is excluded.
        const pendingRes = await authedGet(
          '?status=pending_verification&limit=100',
        ).expect(200);
        const pendingIds = (pendingRes.body as PaginatedAdminOrders).data.map(
          (o) => o.orderId,
        );
        expect(pendingIds).toContain(pagoMovilOrderId);
        expect(pendingIds).not.toContain(stripeOrderId);

        // --- AC3: paymentRail=stripe -> only the Stripe Order is present;
        // the Pago Móvil Order is excluded.
        const stripeRailRes = await authedGet(
          '?paymentRail=stripe&limit=100',
        ).expect(200);
        const stripeRailIds = (
          stripeRailRes.body as PaginatedAdminOrders
        ).data.map((o) => o.orderId);
        expect(stripeRailIds).toContain(stripeOrderId);
        expect(stripeRailIds).not.toContain(pagoMovilOrderId);

        // --- AC3: status + paymentRail combine with AND, matching our
        // paid+stripe Order but not our pending+pago_movil one.
        const combinedMatchRes = await authedGet(
          '?status=paid&paymentRail=stripe&limit=100',
        ).expect(200);
        const combinedMatchIds = (
          combinedMatchRes.body as PaginatedAdminOrders
        ).data.map((o) => o.orderId);
        expect(combinedMatchIds).toContain(stripeOrderId);
        expect(combinedMatchIds).not.toContain(pagoMovilOrderId);

        // --- AND (never OR): a combination that matches neither of our 2
        // Orders (paid+pago_movil never occurs in this codebase — Story
        // 9.2's admin confirm doesn't exist yet, so nothing can EVER reach
        // that combination) returns neither.
        const combinedNoMatchRes = await authedGet(
          '?status=paid&paymentRail=pago_movil&limit=100',
        ).expect(200);
        const combinedNoMatchIds = (
          combinedNoMatchRes.body as PaginatedAdminOrders
        ).data.map((o) => o.orderId);
        expect(combinedNoMatchIds).not.toContain(pagoMovilOrderId);
        expect(combinedNoMatchIds).not.toContain(stripeOrderId);

        // --- Story 14.6 (AD-49): the retired rail value is a stable 400.
        await authedGet('?paymentRail=pay' + 'pal').expect(400);
      } finally {
        await cleanupPagoMovilOrder(pagoMovilOrderId);
        await cleanupStripeOrder(stripeOrderId, DBS_UNION_FORCE_ID, 1);
      }
    });

    it('pagination: limit is honored and totalPages = ceil(total/limit)', async () => {
      const res = await authedGet('?limit=1').expect(200);
      const body = res.body as PaginatedAdminOrders;
      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.meta.limit).toBe(1);
      expect(body.meta.totalPages).toBe(Math.ceil(body.meta.total / 1));
    });

    it('default sortOrder is createdAt desc; sortOrder=asc reverses it (checked via 2 Orders we fully control)', async () => {
      const olderOrderId = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);
      const newerOrderId = await createPagoMovilOrder(OP_ROMANCE_DAWN_ID, 1);

      try {
        const descRes = await authedGet(
          '?status=pending_verification&paymentRail=pago_movil&limit=100',
        ).expect(200);
        const descIds = (descRes.body as PaginatedAdminOrders).data.map(
          (o) => o.orderId,
        );
        const descOlderIdx = descIds.indexOf(olderOrderId);
        const descNewerIdx = descIds.indexOf(newerOrderId);
        if (descOlderIdx === -1 || descNewerIdx === -1) {
          throw new Error(
            `Expected both test Orders in the default (desc) list, got: ${JSON.stringify(descIds)}`,
          );
        }
        // Most recent first by default: the newer Order comes BEFORE the
        // older one.
        expect(descNewerIdx).toBeLessThan(descOlderIdx);

        const ascRes = await authedGet(
          '?status=pending_verification&paymentRail=pago_movil&sortOrder=asc&limit=100',
        ).expect(200);
        const ascIds = (ascRes.body as PaginatedAdminOrders).data.map(
          (o) => o.orderId,
        );
        const ascOlderIdx = ascIds.indexOf(olderOrderId);
        const ascNewerIdx = ascIds.indexOf(newerOrderId);
        if (ascOlderIdx === -1 || ascNewerIdx === -1) {
          throw new Error(
            `Expected both test Orders in the sortOrder=asc list, got: ${JSON.stringify(ascIds)}`,
          );
        }
        expect(ascOlderIdx).toBeLessThan(ascNewerIdx);
      } finally {
        await cleanupPagoMovilOrder(olderOrderId);
        await cleanupPagoMovilOrder(newerOrderId);
      }
    });
  });
});
