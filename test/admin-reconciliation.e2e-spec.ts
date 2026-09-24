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

interface ReconciliationEntry {
  paymentRail: string;
  status: string;
  orderCount: number;
  totalUsd: number;
  totalVes: number | null;
}

interface ReconciliationRailTotal {
  paymentRail: string;
  orderCount: number;
  totalUsd: number;
  totalVes: number | null;
}

interface ReconciliationResponse {
  from: string;
  to: string;
  breakdown: ReconciliationEntry[];
  totalsByRail: ReconciliationRailTotal[];
  grandTotal: { orderCount: number; totalUsd: number; totalVes: number | null };
}

interface CheckoutResponse {
  orderId: string;
  orderAccessToken: string;
  paypal: { paypalOrderId: string; approveUrl: string } | null;
}

interface ApiErrorBody {
  errorCode?: string;
}

const TEST_USERNAME = 'e2e-admin-story-9-4';
const TEST_EMAIL = 'e2e-admin-story-9-4@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-9f4c';

// Story 1.4 seed Products, same "ample stock, self-contained cleanup"
// convention admin-orders.e2e-spec.ts (Story 9.1) already established for
// this exact pair — no dedicated products needed here: this suite never
// asserts on `stock`/`heldQty` values (only on Order.totalUsd/paymentRail/
// status), so the concurrency-isolation concern that justifies a
// file-dedicated product elsewhere (e.g. admin-payment-decision.e2e-spec.ts's
// ONE_PIECE_DECK_ID) doesn't apply to this file.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180, priceUsd 4.49
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

function pagoMovilPickupBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'pago_movil',
    fulfillmentType: 'pickup',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

function paypalPickupBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'paypal',
    fulfillmentType: 'pickup',
    recipientName: 'Carlos Gomez',
    recipientPhone: '0414-7654321',
    ...overrides,
  };
}

/**
 * Story 9.4 (FR-28, NFR-4; AD-11, AD-14). Full-stack e2e coverage (real
 * AdminAuthGuard, real Postgres, real `GROUP BY ROLLUP` raw query) of
 * `GET /api/v1/admin/orders/reconciliation`.
 *
 * **Parallelism-safety note** (see PROJECT-STATE.md's Story 9.3 QA
 * finding on shared-fixture/global-count fragility under Vitest's default
 * file parallelism): this endpoint aggregates over EVERY Order in a
 * `createdAt` window, with no `productId` scoping at all — so unlike
 * earlier suites, dedicating a Product doesn't protect this file from
 * concurrent Orders created by OTHER e2e files landing inside the same
 * wall-clock window. Instead of hard-coding an expected total (which
 * would be flaky under file parallelism), the main scenario below
 * independently re-derives the expected aggregate with a **direct Prisma
 * query over the identical `[from, to]` window** right before comparing —
 * so both sides of the assertion see the exact same live DB state,
 * whatever else is concurrently running. This makes the test correct
 * under real parallel execution, not just in isolation.
 */
describe('AdminOrdersController — Story 9.4 reconciliation (e2e)', () => {
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

  function authedGet(query: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/admin/orders/reconciliation${query}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

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
      .send(pagoMovilPickupBody())
      .expect(201);
    return (checkoutRes.body as CheckoutResponse).orderId;
  }

  async function createPaidPaypalOrder(
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
      .send(paypalPickupBody())
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;
    if (!body.paypal) {
      throw new Error(
        `Expected a paypal session, got: ${JSON.stringify(body)}`,
      );
    }

    await request(app.getHttpServer())
      .post('/api/v1/payments/paypal/webhook')
      .send({
        paypalOrderId: body.paypal.paypalOrderId,
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
      })
      .expect(200);

    return body.orderId;
  }

  async function cleanupPagoMovilOrder(orderId: string): Promise<void> {
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

  async function cleanupPaypalOrder(
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

  /** Re-derives the exact same 3-tier aggregate (`breakdown`/`totalsByRail`/
   * `grandTotal`) the service's `GROUP BY ROLLUP` query produces, but via
   * plain Prisma reads + a JS reduction — so the test has an independent
   * ground truth to compare the raw-SQL endpoint against, computed over
   * the SAME live window at the SAME moment (see the describe block's own
   * parallelism-safety note). */
  async function computeExpectedReconciliation(
    from: Date,
    to: Date,
  ): Promise<ReconciliationResponse> {
    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        paymentRail: true,
        status: true,
        totalUsd: true,
        totalVes: true,
      },
    });

    const breakdownMap = new Map<string, ReconciliationEntry>();
    const railMap = new Map<string, ReconciliationRailTotal>();
    const grandTotal = {
      orderCount: 0,
      totalUsd: 0,
      totalVes: null as number | null,
    };

    for (const order of orders) {
      const paymentRail = order.paymentRail.toLowerCase();
      const status = order.status.toLowerCase();
      const totalUsd = Number(order.totalUsd);
      const totalVes = order.totalVes !== null ? Number(order.totalVes) : null;

      const breakdownKey = `${paymentRail}|${status}`;
      const existingEntry = breakdownMap.get(breakdownKey) ?? {
        paymentRail,
        status,
        orderCount: 0,
        totalUsd: 0,
        totalVes: totalVes !== null ? 0 : null,
      };
      existingEntry.orderCount += 1;
      existingEntry.totalUsd += totalUsd;
      if (totalVes !== null) {
        existingEntry.totalVes = (existingEntry.totalVes ?? 0) + totalVes;
      }
      breakdownMap.set(breakdownKey, existingEntry);

      const railTotal = railMap.get(paymentRail) ?? {
        paymentRail,
        orderCount: 0,
        totalUsd: 0,
        totalVes: totalVes !== null ? 0 : null,
      };
      railTotal.orderCount += 1;
      railTotal.totalUsd += totalUsd;
      if (totalVes !== null) {
        railTotal.totalVes = (railTotal.totalVes ?? 0) + totalVes;
      }
      railMap.set(paymentRail, railTotal);

      grandTotal.orderCount += 1;
      grandTotal.totalUsd += totalUsd;
      if (totalVes !== null) {
        grandTotal.totalVes = (grandTotal.totalVes ?? 0) + totalVes;
      }
    }

    const sortEntries = <T extends { paymentRail: string; status?: string }>(
      rows: T[],
    ): T[] =>
      [...rows].sort((a, b) => {
        const railCompare = a.paymentRail.localeCompare(b.paymentRail);
        if (railCompare !== 0) return railCompare;
        return (a.status ?? '').localeCompare(b.status ?? '');
      });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      breakdown: sortEntries([...breakdownMap.values()]),
      totalsByRail: sortEntries([...railMap.values()]),
      grandTotal,
    };
  }

  function expectRowsClose<
    T extends { orderCount: number; totalUsd: number; totalVes: number | null },
  >(actual: T[], expected: T[]): void {
    expect(actual.length).toBe(expected.length);
    actual.forEach((actualRow, index) => {
      const expectedRow = expected[index];
      expect(actualRow.orderCount).toBe(expectedRow.orderCount);
      expect(actualRow.totalUsd).toBeCloseTo(expectedRow.totalUsd, 2);
      if (expectedRow.totalVes === null) {
        expect(actualRow.totalVes).toBeNull();
      } else {
        expect(actualRow.totalVes).toBeCloseTo(expectedRow.totalVes, 2);
      }
      expect(JSON.stringify(actualRow)).toContain(
        `"paymentRail":"${expectedRow.paymentRail}"`,
      );
    });
  }

  describe('AdminAuthGuard gating', () => {
    it('no token: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get(
          '/api/v1/admin/orders/reconciliation?from=2026-01-01&to=2026-01-31',
        )
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });
  });

  describe('malformed from/to (NFR-4): stable 400, never 500', () => {
    it('missing from/to: 400', async () => {
      await authedGet('').expect(400);
    });

    it('from is not a valid ISO-8601 date: 400', async () => {
      await authedGet('?from=not-a-date&to=2026-09-30').expect(400);
    });

    it('to is not a valid ISO-8601 date: 400', async () => {
      await authedGet('?from=2026-09-01&to=not-a-date').expect(400);
    });

    it('to before from: 400', async () => {
      await authedGet('?from=2026-09-30&to=2026-09-01').expect(400);
    });
  });

  describe('a period with no payments (AC3)', () => {
    it('returns a valid empty result, never an error', async () => {
      const res = await authedGet('?from=2000-01-01&to=2000-01-02').expect(200);
      const body = res.body as ReconciliationResponse;
      expect(body.breakdown).toEqual([]);
      expect(body.totalsByRail).toEqual([]);
      expect(body.grandTotal).toEqual({
        orderCount: 0,
        totalUsd: 0,
        totalVes: null,
      });
    });
  });

  describe('consolidated aggregate over real Orders across both rails (AC1)', () => {
    it('correctly sums totalUsd/totalVes grouped by (paymentRail, status), with per-rail and grand totals, matching an independent DB query over the same window', async () => {
      const confirmedPagoMovilOrderId = await createPagoMovilOrder(
        OP_ROMANCE_DAWN_ID,
        2,
      );
      const rejectedPagoMovilOrderId = await createPagoMovilOrder(
        OP_ROMANCE_DAWN_ID,
        1,
      );
      const paidPaypalOrderId = await createPaidPaypalOrder(
        DBS_UNION_FORCE_ID,
        1,
      );

      try {
        // Move the two Pago Móvil Orders to real terminal states via the
        // Story 9.2 admin routes — same real state machine transitions an
        // admin would actually trigger, not a hand-inserted row.
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/orders/${confirmedPagoMovilOrderId}/confirm-payment`,
          )
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/orders/${rejectedPagoMovilOrderId}/reject-payment`,
          )
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        // Backdate all 3 Orders' `createdAt` into a fixed historical
        // window nothing else in this codebase ever touches (real
        // checkouts always run at "now"). This is the actual fix for the
        // parallelism-safety concern this describe block's own doc
        // comment raises: a wall-clock `[from, to]` window shared with 16
        // OTHER e2e files creating/deleting real Orders concurrently is
        // provably racy — a Prisma read (`computeExpectedReconciliation`)
        // and an HTTP round-trip (`authedGet`) are two separate
        // point-in-time snapshots of a table other files mutate between
        // them, so an exact-count comparison over "the last few seconds"
        // can and did flake under real parallel execution. Pinning our 3
        // Orders to a window (June 2015) no other suite could ever
        // produce a matching `createdAt` for makes BOTH reads
        // deterministic and immune to concurrent noise, while still
        // exercising the exact same raw-SQL aggregate over real Order
        // rows written through the real checkout/confirm/reject flow.
        const fixedFrom = new Date('2015-06-01T00:00:00.000Z');
        const fixedTo = new Date('2015-06-02T00:00:00.000Z');
        await prisma.order.updateMany({
          where: {
            id: {
              in: [
                confirmedPagoMovilOrderId,
                rejectedPagoMovilOrderId,
                paidPaypalOrderId,
              ],
            },
          },
          data: { createdAt: new Date('2015-06-01T12:00:00.000Z') },
        });

        const expected = await computeExpectedReconciliation(
          fixedFrom,
          fixedTo,
        );

        const res = await authedGet(
          `?from=${fixedFrom.toISOString()}&to=${fixedTo.toISOString()}`,
        ).expect(200);
        const body = res.body as ReconciliationResponse;

        // Sanity check: our 3 Orders (2 distinct pago_movil statuses + 1
        // paypal) are actually inside both the endpoint's response and the
        // independent ground truth — otherwise the loop below would
        // vacuously pass on an empty window.
        expect(expected.breakdown.length).toBeGreaterThanOrEqual(3);
        const sortedBody = {
          ...body,
          breakdown: [...body.breakdown].sort((a, b) =>
            `${a.paymentRail}|${a.status}`.localeCompare(
              `${b.paymentRail}|${b.status}`,
            ),
          ),
          totalsByRail: [...body.totalsByRail].sort((a, b) =>
            a.paymentRail.localeCompare(b.paymentRail),
          ),
        };

        expectRowsClose(sortedBody.breakdown, expected.breakdown);
        expectRowsClose(sortedBody.totalsByRail, expected.totalsByRail);
        expect(body.grandTotal.orderCount).toBe(expected.grandTotal.orderCount);
        expect(body.grandTotal.totalUsd).toBeCloseTo(
          expected.grandTotal.totalUsd,
          2,
        );

        // Payment Rail must be distinguishable "at a glance" (AC1): every
        // breakdown entry for our 3 Orders carries an explicit rail.
        const paidPagoMovilEntry = body.breakdown.find(
          (e) => e.paymentRail === 'pago_movil' && e.status === 'paid',
        );
        const rejectedPagoMovilEntry = body.breakdown.find(
          (e) =>
            e.paymentRail === 'pago_movil' && e.status === 'payment_rejected',
        );
        const paidPaypalEntry = body.breakdown.find(
          (e) => e.paymentRail === 'paypal' && e.status === 'paid',
        );
        expect(paidPagoMovilEntry).toBeDefined();
        expect(rejectedPagoMovilEntry).toBeDefined();
        expect(paidPaypalEntry).toBeDefined();
        // AD-3: totalVes is always populated for pago_movil, always null
        // for paypal.
        expect(paidPagoMovilEntry?.totalVes).not.toBeNull();
        expect(paidPaypalEntry?.totalVes).toBeNull();
      } finally {
        await cleanupPagoMovilOrder(rejectedPagoMovilOrderId);
        // The confirmed Order's hold was already consumed (converted into
        // a real stock decrement) by confirm-payment — restore stock
        // directly, same as a "paid" Order's cleanup elsewhere in this
        // repo (e.g. admin-fulfillment-decision.e2e-spec.ts).
        await prisma.product.update({
          where: { id: OP_ROMANCE_DAWN_ID },
          data: { stock: { increment: 2 } },
        });
        await prisma.order
          .delete({ where: { id: confirmedPagoMovilOrderId } })
          .catch(() => undefined);
        await cleanupPaypalOrder(paidPaypalOrderId, DBS_UNION_FORCE_ID, 1);
      }
    });
  });
});
