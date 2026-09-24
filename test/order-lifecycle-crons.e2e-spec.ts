import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { StockHoldExpiryCronService } from './../src/orders/cron/stock-hold-expiry-cron.service.js';
import { PaymentProcessingTimeoutCronService } from './../src/orders/cron/payment-processing-timeout-cron.service.js';
import { Prisma } from './../src/generated/prisma/client.js';
import {
  Franchise,
  FulfillmentType,
  OrderActorType,
  OrderStatus,
  PaymentRail,
  ProductType,
  Rarity,
} from './../src/generated/prisma/enums.js';
import { hashOrderAccessToken } from './../src/common/order-access-token.js';

/**
 * Story 5.2 e2e suite. Runs against real Postgres via the full `AppModule`
 * DI wiring (same convention every other `*.e2e-spec.ts` file already
 * uses) but never goes through HTTP/`supertest` — both crons' real work
 * (`runExpiryCheck`/`runTimeoutCheck`) are plain injectable service
 * methods with no controller, so this suite calls them DIRECTLY, exactly
 * as they're designed to be tested (never waiting on the real 5-minute
 * `@Cron` interval).
 *
 * **Fixtures are built directly via Prisma, bypassing cart/checkout**
 * (same reasoning `order-lookup.e2e-spec.ts` already documents for most of
 * its own tests): this suite's scope is the cron logic itself, not
 * checkout. Every seeded catalog Product is already claimed by some other
 * `*.e2e-spec.ts` file's own stock/heldQty mutations, so each test here
 * creates its OWN throwaway Product (a fresh UUID, a real seeded
 * Category) instead of touching any shared seed row — zero cross-file
 * collision risk under Vitest's parallel file execution, no "restore
 * afterward" bookkeeping needed beyond deleting what this file itself
 * created.
 */
describe('Order-lifecycle crons: StockHold expiry + payment_processing timeout (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stockHoldExpiryCron: StockHoldExpiryCronService;
  let paymentTimeoutCron: PaymentProcessingTimeoutCronService;

  // A real, static seeded Category (Story 1.4) — never mutated by any
  // other test file, safe to reference from every throwaway Product below.
  const CARTAS_SUELTAS_CATEGORY_ID = 'dd848f24-aac0-4346-ae25-b672bb0d7e14';

  const createdProductIds: string[] = [];
  const createdOrderIds: string[] = [];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    stockHoldExpiryCron = app.get(StockHoldExpiryCronService);
    paymentTimeoutCron = app.get(PaymentProcessingTimeoutCronService);
  });

  afterEach(async () => {
    // Cascading deletes (OrderLine/OrderStatusHistory/StockHold all
    // `onDelete: Cascade` off Order, per schema.prisma) — deleting the
    // Order is enough; the throwaway Product is deleted separately.
    for (const orderId of createdOrderIds.splice(0)) {
      await prisma.order
        .delete({ where: { id: orderId } })
        .catch(() => undefined);
    }
    for (const productId of createdProductIds.splice(0)) {
      await prisma.product
        .delete({ where: { id: productId } })
        .catch(() => undefined);
    }
    await app.close();
  });

  async function createTestProduct(opts: {
    stock: number;
    heldQty?: number;
  }): Promise<{ id: string; name: string; priceUsd: Prisma.Decimal }> {
    const suffix = randomUUID();
    const product = await prisma.product.create({
      data: {
        name: `Story 5.2 cron test product ${suffix}`,
        slug: `story-5-2-cron-test-${suffix}`,
        description:
          'Ephemeral Product created only for the Story 5.2 cron e2e suite.',
        franchise: Franchise.POKEMON,
        productType: ProductType.SINGLE_CARD,
        rarity: Rarity.COMMON,
        priceUsd: new Prisma.Decimal('10.00'),
        stock: opts.stock,
        heldQty: opts.heldQty ?? 0,
        categoryId: CARTAS_SUELTAS_CATEGORY_ID,
      },
    });
    createdProductIds.push(product.id);
    return { id: product.id, name: product.name, priceUsd: product.priceUsd };
  }

  /** Builds a `pending_verification` Pago Móvil Order with exactly one
   * OrderLine + one StockHold against `product`, directly via Prisma
   * (never through the real `/checkout` endpoint — see this suite's own
   * doc comment). */
  async function createPendingVerificationOrderWithHold(
    product: { id: string; name: string; priceUsd: Prisma.Decimal },
    opts: { quantity: number; expiresAt: Date },
  ): Promise<string> {
    const tokenHash = hashOrderAccessToken(randomUUID());
    const lineTotal = product.priceUsd.times(opts.quantity);
    const order = await prisma.order.create({
      data: {
        status: OrderStatus.PENDING_VERIFICATION,
        paymentRail: PaymentRail.PAGO_MOVIL,
        fulfillmentType: FulfillmentType.PICKUP,
        recipientName: 'Story 5.2 Test Buyer',
        recipientPhone: '0412-0000000',
        totalUsd: lineTotal,
        fxRateVesPerUsd: new Prisma.Decimal('200.0000'),
        totalVes: lineTotal.times('200.0000'),
        accessTokenHash: tokenHash,
        lines: {
          create: [
            {
              productId: product.id,
              productName: product.name,
              unitPriceUsd: product.priceUsd,
              quantity: opts.quantity,
              lineTotalUsd: lineTotal,
            },
          ],
        },
        stockHolds: {
          create: [
            {
              productId: product.id,
              quantity: opts.quantity,
              expiresAt: opts.expiresAt,
            },
          ],
        },
        statusHistory: {
          create: [
            {
              fromStatus: null,
              toStatus: OrderStatus.PENDING_VERIFICATION,
              actorType: OrderActorType.SYSTEM,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    return order.id;
  }

  /** Builds a `payment_processing` PayPal Order (no StockHold — PayPal
   * orders never hold stock, per AD-13), directly via Prisma, with
   * `createdAt` backdated to simulate elapsed time without waiting. */
  async function createPaymentProcessingOrder(opts: {
    createdAt: Date;
  }): Promise<string> {
    const tokenHash = hashOrderAccessToken(randomUUID());
    const order = await prisma.order.create({
      data: {
        status: OrderStatus.PAYMENT_PROCESSING,
        paymentRail: PaymentRail.PAYPAL,
        fulfillmentType: FulfillmentType.PICKUP,
        recipientName: 'Story 5.2 Test Buyer',
        recipientPhone: '0412-0000000',
        totalUsd: new Prisma.Decimal('10.00'),
        accessTokenHash: tokenHash,
        paypalOrderId: `story-5-2-test-${randomUUID()}`,
        createdAt: opts.createdAt,
        statusHistory: {
          create: [
            {
              fromStatus: null,
              toStatus: OrderStatus.PAYMENT_PROCESSING,
              actorType: OrderActorType.SYSTEM,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    return order.id;
  }

  describe('StockHoldExpiryCronService.runExpiryCheck', () => {
    it('an expired hold on a still pending_verification Order: heldQty decrements by exactly the held quantity, the hold is marked released, and the Order transitions to expired (actorType=CRON)', async () => {
      const product = await createTestProduct({ stock: 20, heldQty: 3 });
      const orderId = await createPendingVerificationOrderWithHold(product, {
        quantity: 3,
        expiresAt: new Date(Date.now() - 60 * 1000), // 1 minute in the past
      });

      const result = await stockHoldExpiryCron.runExpiryCheck();

      expect(result.ordersExpired).toBe(1);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.heldQty).toBe(0);
      expect(after.stock).toBe(20); // expiry never touches `stock`, only `heldQty`

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          stockHolds: true,
          statusHistory: { orderBy: { createdAt: 'asc' } },
        },
      });
      expect(order.status).toBe(OrderStatus.EXPIRED);
      expect(order.stockHolds).toHaveLength(1);
      expect(order.stockHolds[0].releasedAt).not.toBeNull();
      expect(order.statusHistory).toHaveLength(2);
      expect(order.statusHistory[1]).toMatchObject({
        fromStatus: OrderStatus.PENDING_VERIFICATION,
        toStatus: OrderStatus.EXPIRED,
        actorType: OrderActorType.CRON,
      });
    });

    it('a hold that has NOT expired yet: heldQty and the Order are both left untouched', async () => {
      const product = await createTestProduct({ stock: 20, heldQty: 2 });
      const orderId = await createPendingVerificationOrderWithHold(product, {
        quantity: 2,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour in the future
      });

      const result = await stockHoldExpiryCron.runExpiryCheck();

      expect(result.ordersExpired).toBe(0);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.heldQty).toBe(2);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { stockHolds: true },
      });
      expect(order.status).toBe(OrderStatus.PENDING_VERIFICATION);
      expect(order.stockHolds[0].releasedAt).toBeNull();
    });

    it('an Order already resolved (e.g. PAID) before the cron runs, with an expired unreleased hold: the cron skips it safely — no history duplicated, no heldQty touched, status never resurrected/overwritten', async () => {
      const product = await createTestProduct({ stock: 20, heldQty: 4 });
      const orderId = await createPendingVerificationOrderWithHold(product, {
        quantity: 4,
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
      // Simulates an admin having already confirmed payment (Story 9.2,
      // not yet implemented) between this hold being created and the
      // cron running — the Order left pending_verification, but nothing
      // in this fixture releases the StockHold row itself, exactly the
      // defensive edge case AC3 describes. Caught here by
      // `runExpiryCheck`'s own candidate-selection query (which already
      // filters on `order.status = pending_verification`) — this Order
      // never even becomes a candidate, so neither counter increments;
      // the genuine "guard fires mid-transaction" race (the OTHER way
      // AC3's invariant is enforced) is covered by the concurrency test
      // below, and by this same guard's own dedicated unit coverage in
      // `order-status-transition.spec.ts` / `stock-hold-expiry-cron.service.spec.ts`.
      await prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.PAID },
      });

      const result = await stockHoldExpiryCron.runExpiryCheck();

      expect(result.ordersExpired).toBe(0);
      expect(result.ordersSkippedConflict).toBe(0);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.heldQty).toBe(4); // untouched

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true, stockHolds: true },
      });
      expect(order.status).toBe(OrderStatus.PAID); // never resurrected/overwritten
      expect(order.statusHistory).toHaveLength(1); // no extra history row written
      expect(order.stockHolds[0].releasedAt).toBeNull();
    });

    it('two simultaneous cron runs racing the SAME expired hold: the invariant holds regardless of which safety net (the top-level candidate pre-filter or the guarded UPDATE itself) absorbs the race — exactly one expiry, no double release, no duplicate history', async () => {
      // Whichever of the two concurrent `runExpiryCheck()` calls' DB round
      // trips happens to interleave first is inherently non-deterministic
      // (real network/event-loop timing, not something this test controls)
      // — it may land on the guarded UPDATE inside `expireOneOrder`
      // (`OrderTransitionConflictError` -> `ordersSkippedConflict`) or on
      // the earlier candidate-selection query already reflecting the
      // other call's committed change (never even becomes a candidate).
      // Both are safe per AC3; this test asserts the OUTCOME invariant
      // that must hold either way, not which specific counter absorbs it
      // (the guard's own branch is deterministically exercised by
      // `stock-hold-expiry-cron.service.spec.ts`'s mocked unit test).
      const product = await createTestProduct({ stock: 20, heldQty: 6 });
      const orderId = await createPendingVerificationOrderWithHold(product, {
        quantity: 6,
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      const [resultA, resultB] = await Promise.all([
        stockHoldExpiryCron.runExpiryCheck(),
        stockHoldExpiryCron.runExpiryCheck(),
      ]);

      const totalExpired = resultA.ordersExpired + resultB.ordersExpired;
      expect(totalExpired).toBe(1); // expired exactly once, by exactly one of the two calls

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.heldQty).toBe(0); // decremented exactly once, never twice, never negative

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true },
      });
      expect(order.status).toBe(OrderStatus.EXPIRED);
      expect(order.statusHistory).toHaveLength(2); // exactly one expired row, not two
    });

    it('running the cron twice in a row over the same already-expired scenario: the second run is a safe no-op — no double transition, no further heldQty change', async () => {
      const product = await createTestProduct({ stock: 20, heldQty: 5 });
      const orderId = await createPendingVerificationOrderWithHold(product, {
        quantity: 5,
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      const firstRun = await stockHoldExpiryCron.runExpiryCheck();
      expect(firstRun.ordersExpired).toBe(1);

      const afterFirst = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(afterFirst.heldQty).toBe(0);

      const secondRun = await stockHoldExpiryCron.runExpiryCheck();
      expect(secondRun.ordersExpired).toBe(0);
      expect(secondRun.ordersSkippedConflict).toBe(0); // not even a candidate anymore

      const afterSecond = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(afterSecond.heldQty).toBe(0); // unchanged by the second run

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true },
      });
      expect(order.status).toBe(OrderStatus.EXPIRED);
      expect(order.statusHistory).toHaveLength(2); // still exactly 2 — no duplicate
    });
  });

  describe('PaymentProcessingTimeoutCronService.runTimeoutCheck', () => {
    it('a payment_processing Order older than 30 minutes: transitions to payment_failed (actorType=CRON), never touching any Product', async () => {
      const orderId = await createPaymentProcessingOrder({
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      });

      const result = await paymentTimeoutCron.runTimeoutCheck();

      expect(result.ordersFailed).toBe(1);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
      expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
      expect(order.statusHistory).toHaveLength(2);
      expect(order.statusHistory[1]).toMatchObject({
        fromStatus: OrderStatus.PAYMENT_PROCESSING,
        toStatus: OrderStatus.PAYMENT_FAILED,
        actorType: OrderActorType.CRON,
      });
    });

    it('a payment_processing Order still within the 30-minute window: left untouched', async () => {
      const orderId = await createPaymentProcessingOrder({
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      });

      const result = await paymentTimeoutCron.runTimeoutCheck();

      expect(result.ordersFailed).toBe(0);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(order.status).toBe(OrderStatus.PAYMENT_PROCESSING);
    });

    it('running the cron twice in a row over the same already-timed-out Order: the second run is a safe no-op — no double transition', async () => {
      const orderId = await createPaymentProcessingOrder({
        createdAt: new Date(Date.now() - 45 * 60 * 1000),
      });

      const firstRun = await paymentTimeoutCron.runTimeoutCheck();
      expect(firstRun.ordersFailed).toBe(1);

      const secondRun = await paymentTimeoutCron.runTimeoutCheck();
      expect(secondRun.ordersFailed).toBe(0);
      expect(secondRun.ordersSkippedConflict).toBe(0); // not even a candidate anymore

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: true },
      });
      expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
      expect(order.statusHistory).toHaveLength(2); // still exactly 2 — no duplicate
    });
  });
});
