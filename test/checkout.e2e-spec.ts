import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SINGLETON_FX_RATE_ID } from './../src/checkout/fx-rate.constants.js';

type App = Parameters<typeof request>[0];

// Seeded Products (Story 1.4, prisma/seed.ts) deliberately NOT already
// claimed by cart.e2e-spec.ts's own tests (PIKACHU_PROMO/LUFFY_LEADER/
// CHARIZARD_VMAX/BLUE_EYES/YUGIOH_BOX/POKEMON_SOBRE/ONE_PIECE_DECK — see
// that file's own comment) — reusing those here would risk cross-file
// flakiness in a parallel run, same reasoning that file documents.
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97'; // stock 180
const MTG_TIN_ID = 'c1701d9e-5fd2-4083-98f2-ce751d7ed64b'; // stock 20
const SV_BOOSTER_BOX_ID = '7abf28f6-a761-4d1a-b2a7-f1e1a05e2a19'; // stock 15

interface CheckoutOrderLine {
  productId: string;
  productName: string;
  unitPriceUsd: number;
  quantity: number;
  lineTotalUsd: number;
}

interface CheckoutResponse {
  orderId: string;
  status: string;
  totalUsd: number;
  fxRateVesPerUsd: number;
  totalVes: number;
  lines: CheckoutOrderLine[];
  paymentInstructions: {
    bankName: string;
    idNumber: string;
    phone: string;
    reference: string;
  };
  orderAccessToken: string;
}

interface ApiErrorBody {
  errorCode?: string;
  details?: Record<string, unknown>;
}

// Same helper cart.e2e-spec.ts already established — pulls the raw
// `cartId=...` Set-Cookie string out of a response so it can be replayed
// on a follow-up request via `.set('Cookie', ...)`.
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

function pickupBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'pago_movil',
    fulfillmentType: 'pickup',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

function deliveryBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentRail: 'pago_movil',
    fulfillmentType: 'delivery',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    addressLine1: 'Av. Francisco de Miranda, Torre A',
    city: 'Caracas',
    state: 'Distrito Capital',
    ...overrides,
  };
}

// Runs against the shared dev Postgres seeded by Story 1.4 (prisma/seed.ts)
// and Story 4.1's own FxRateSetting seed row, same as every other
// *.e2e-spec.ts in this suite. Every test that performs a REAL successful
// checkout restores the Product(s) it touches (heldQty) and deletes the
// Order it created (which cascades to OrderLine/OrderStatusHistory/
// StockHold) in a `finally` block — the same "mutate, assert, restore"
// discipline products.e2e-spec.ts / cart.e2e-spec.ts already use for stock/
// price mutations, applied here to checkout's own Product.heldQty writes
// (there is no admin/cron endpoint yet — Stories 5.2/9.2 — to release a
// hold through the public API, so tests clean up directly via Prisma).
describe('CheckoutController (e2e)', () => {
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

  /** Deletes the Order (cascades OrderLine/OrderStatusHistory/StockHold)
   * and gives back every unit of stock it held, restoring the touched
   * Products to their pre-test state. */
  async function cleanupOrder(orderId: string): Promise<void> {
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
    await prisma.order.delete({ where: { id: orderId } });
  }

  describe('rejections that never touch the cart/Order (DTO-level, NFR-3)', () => {
    it('400s when recipientName is missing', () => {
      const body = pickupBody();
      delete (body as Record<string, unknown>).recipientName;
      return request(app.getHttpServer())
        .post('/api/v1/checkout')
        .send(body)
        .expect(400);
    });

    it('400s when fulfillmentType is missing entirely (no explicit pickup or delivery selection)', () => {
      const body = pickupBody();
      delete (body as Record<string, unknown>).fulfillmentType;
      return request(app.getHttpServer())
        .post('/api/v1/checkout')
        .send(body)
        .expect(400);
    });

    it('400s when fulfillmentType=delivery is missing its address fields', () => {
      return request(app.getHttpServer())
        .post('/api/v1/checkout')
        .send({
          paymentRail: 'pago_movil',
          fulfillmentType: 'delivery',
          recipientName: 'Maria Perez',
          recipientPhone: '0412-1234567',
          // no addressLine1/city/state
        })
        .expect(400);
    });

    it('400s on a paymentRail other than pago_movil (e.g. paypal — not wired up until Story 4.3)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/checkout')
        .send(pickupBody({ paymentRail: 'paypal' }))
        .expect(400);
    });
  });

  describe('empty cart', () => {
    it('rejects with 422 errorCode EMPTY_CART when there is no cart cookie at all', () => {
      return request(app.getHttpServer())
        .post('/api/v1/checkout')
        .send(pickupBody())
        .expect(422)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'EMPTY_CART') {
            throw new Error(
              `Expected errorCode EMPTY_CART, got: ${JSON.stringify(body)}`,
            );
          }
        });
    });
  });

  it('successful PICKUP checkout: snapshots each line, sets totals/FX once, creates a guarded StockHold per line, writes the []->pending_verification history row, clears the cart, and returns a token whose hash (not the raw value) matches Order.accessTokenHash', async () => {
    const addFirst = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: OP_ROMANCE_DAWN_ID, quantity: 2 })
      .expect(201);
    const cartCookie = extractCartCookie(addFirst);
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Cookie', cartCookie)
      .send({ productId: MTG_TIN_ID, quantity: 1 })
      .expect(201);

    const fxRate = await prisma.fxRateSetting.findUniqueOrThrow({
      where: { id: SINGLETON_FX_RATE_ID },
    });
    const [opProduct, mtgProduct] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: OP_ROMANCE_DAWN_ID } }),
      prisma.product.findUniqueOrThrow({ where: { id: MTG_TIN_ID } }),
    ]);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send(pickupBody())
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;

    try {
      // --- Response shape/values.
      if (body.status !== 'pending_verification') {
        throw new Error(`Expected pending_verification, got: ${body.status}`);
      }
      const expectedTotalUsd =
        Math.round(
          (Number(opProduct.priceUsd) * 2 + Number(mtgProduct.priceUsd) * 1) *
            100,
        ) / 100;
      if (body.totalUsd !== expectedTotalUsd) {
        throw new Error(
          `Expected totalUsd ${expectedTotalUsd}, got ${body.totalUsd}`,
        );
      }
      if (body.fxRateVesPerUsd !== Number(fxRate.vesPerUsd)) {
        throw new Error(
          `Expected fxRateVesPerUsd ${fxRate.vesPerUsd.toString()}, got ${body.fxRateVesPerUsd}`,
        );
      }
      const expectedTotalVes =
        Math.round(expectedTotalUsd * Number(fxRate.vesPerUsd) * 100) / 100;
      if (body.totalVes !== expectedTotalVes) {
        throw new Error(
          `Expected totalVes ${expectedTotalVes}, got ${body.totalVes}`,
        );
      }
      if (body.lines.length !== 2) {
        throw new Error(`Expected 2 lines, got: ${JSON.stringify(body.lines)}`);
      }
      if (!body.paymentInstructions.reference || !body.orderAccessToken) {
        throw new Error(
          `Expected payment instructions + orderAccessToken, got: ${JSON.stringify(body)}`,
        );
      }

      // --- DB: Order row (price/FX snapshot, status, access token hash —
      // never the raw token).
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: body.orderId },
        include: { lines: true, statusHistory: true, stockHolds: true },
      });
      if (order.status !== 'PENDING_VERIFICATION') {
        throw new Error(`Expected PENDING_VERIFICATION, got ${order.status}`);
      }
      if (order.paymentRail !== 'PAGO_MOVIL') {
        throw new Error(`Expected PAGO_MOVIL, got ${order.paymentRail}`);
      }
      if (order.fulfillmentType !== 'PICKUP') {
        throw new Error(`Expected PICKUP, got ${order.fulfillmentType}`);
      }
      if (
        order.addressLine1 !== null ||
        order.city !== null ||
        order.country !== null
      ) {
        throw new Error(
          `Expected all address fields null for pickup, got: ${JSON.stringify(order)}`,
        );
      }
      const expectedHash = createHash('sha256')
        .update(body.orderAccessToken)
        .digest('hex');
      if (order.accessTokenHash !== expectedHash) {
        throw new Error('accessTokenHash does not match SHA-256(rawToken)');
      }
      if (order.accessTokenHash === body.orderAccessToken) {
        throw new Error(
          'accessTokenHash must never equal the raw orderAccessToken',
        );
      }

      // --- DB: OrderLine snapshots.
      const opLine = order.lines.find(
        (l) => l.productId === OP_ROMANCE_DAWN_ID,
      );
      const mtgLine = order.lines.find((l) => l.productId === MTG_TIN_ID);
      if (
        !opLine ||
        Number(opLine.unitPriceUsd) !== Number(opProduct.priceUsd)
      ) {
        throw new Error(
          `Expected OrderLine unitPriceUsd snapshot to match Product.priceUsd at purchase time`,
        );
      }
      if (opLine.productName !== opProduct.name || opLine.quantity !== 2) {
        throw new Error(
          `Unexpected OrderLine snapshot: ${JSON.stringify(opLine)}`,
        );
      }
      if (!mtgLine || mtgLine.quantity !== 1) {
        throw new Error(
          `Unexpected OrderLine snapshot: ${JSON.stringify(mtgLine)}`,
        );
      }

      // --- DB: StockHold rows + Product.heldQty actually incremented.
      if (order.stockHolds.length !== 2) {
        throw new Error(
          `Expected 2 StockHold rows, got: ${JSON.stringify(order.stockHolds)}`,
        );
      }
      const opHold = order.stockHolds.find(
        (h) => h.productId === OP_ROMANCE_DAWN_ID,
      );
      if (!opHold || opHold.quantity !== 2 || opHold.releasedAt !== null) {
        throw new Error(`Unexpected StockHold: ${JSON.stringify(opHold)}`);
      }
      const reloadedOp = await prisma.product.findUniqueOrThrow({
        where: { id: OP_ROMANCE_DAWN_ID },
      });
      if (reloadedOp.heldQty !== opProduct.heldQty + 2) {
        throw new Error(
          `Expected heldQty to increase by exactly 2, was ${opProduct.heldQty}, now ${reloadedOp.heldQty}`,
        );
      }

      // --- DB: OrderStatusHistory []->pending_verification, actorType=system.
      if (order.statusHistory.length !== 1) {
        throw new Error(
          `Expected exactly 1 OrderStatusHistory row, got: ${JSON.stringify(order.statusHistory)}`,
        );
      }
      const historyRow = order.statusHistory[0];
      if (
        historyRow.fromStatus !== null ||
        historyRow.toStatus !== 'PENDING_VERIFICATION' ||
        historyRow.actorType !== 'SYSTEM'
      ) {
        throw new Error(
          `Unexpected OrderStatusHistory row: ${JSON.stringify(historyRow)}`,
        );
      }

      // --- The cart is gone: a follow-up GET with the SAME (now cleared)
      // cookie shows an empty cart, never the checked-out items.
      const getCartRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Cookie', cartCookie)
        .expect(200);
      const cartBody = getCartRes.body as { items: unknown[]; total: number };
      if (cartBody.items.length !== 0 || cartBody.total !== 0) {
        throw new Error(
          `Expected the cart to be empty after checkout, got: ${JSON.stringify(cartBody)}`,
        );
      }

      // --- The checkout response itself clears the cartId cookie.
      const setCookie = checkoutRes.headers['set-cookie'] as unknown as
        string[] | undefined;
      const clearedCookie = setCookie?.find((c) => c.startsWith('cartId='));
      if (!clearedCookie || !/Expires=/i.test(clearedCookie)) {
        throw new Error(
          `Expected the checkout response to clear the cartId cookie, got: ${JSON.stringify(setCookie)}`,
        );
      }
    } finally {
      await cleanupOrder(body.orderId);
    }
  });

  it('successful DELIVERY checkout: persists the full Venezuela address (country hardcoded server-side) and the recipient fields', async () => {
    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: OP_ROMANCE_DAWN_ID, quantity: 1 })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    const checkoutRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Cookie', cartCookie)
      .send(
        deliveryBody({
          addressLine2: 'Apto 4B',
          recipientName: 'Carlos Gomez',
          recipientPhone: '0414-9998877',
        }),
      )
      .expect(201);
    const body = checkoutRes.body as CheckoutResponse;

    try {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: body.orderId },
      });
      if (order.fulfillmentType !== 'DELIVERY') {
        throw new Error(`Expected DELIVERY, got ${order.fulfillmentType}`);
      }
      if (
        order.recipientName !== 'Carlos Gomez' ||
        order.recipientPhone !== '0414-9998877' ||
        order.addressLine1 !== 'Av. Francisco de Miranda, Torre A' ||
        order.addressLine2 !== 'Apto 4B' ||
        order.city !== 'Caracas' ||
        order.state !== 'Distrito Capital' ||
        order.country !== 'Venezuela'
      ) {
        throw new Error(
          `Unexpected recipient/address fields: ${JSON.stringify(order)}`,
        );
      }
    } finally {
      await cleanupOrder(body.orderId);
    }
  });

  it('re-validates stock at THIS moment: a Product mutated directly in Postgres between add-to-cart and checkout (no longer enough stock) rejects with 409 INSUFFICIENT_STOCK and creates NO Order', async () => {
    const original = await prisma.product.findUniqueOrThrow({
      where: { id: MTG_TIN_ID },
    });

    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: MTG_TIN_ID, quantity: 5 })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);

    try {
      // Simulate stock depleting elsewhere (e.g. an admin adjustment)
      // between add-to-cart and checkout — well below the cart's quantity.
      await prisma.product.update({
        where: { id: MTG_TIN_ID },
        data: { stock: 2 },
      });

      const ordersBefore = await prisma.order.count();

      await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Cookie', cartCookie)
        .send(pickupBody())
        .expect(409)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'INSUFFICIENT_STOCK') {
            throw new Error(
              `Expected errorCode INSUFFICIENT_STOCK, got: ${JSON.stringify(body)}`,
            );
          }
          const items = body.details?.items as
            | Array<{ productId: string; requested: number; available: number }>
            | undefined;
          const issue = items?.find((i) => i.productId === MTG_TIN_ID);
          if (!issue || issue.requested !== 5 || issue.available !== 2) {
            throw new Error(
              `Expected a per-item insufficient-stock reason for ${MTG_TIN_ID}, got: ${JSON.stringify(body)}`,
            );
          }
        });

      const ordersAfter = await prisma.order.count();
      if (ordersAfter !== ordersBefore) {
        throw new Error(
          `Expected no Order to be created on a rejected checkout, before=${ordersBefore} after=${ordersAfter}`,
        );
      }
      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: MTG_TIN_ID },
      });
      if (reloaded.heldQty !== original.heldQty) {
        throw new Error(
          `Expected heldQty unchanged on a rejected checkout, was ${original.heldQty}, now ${reloaded.heldQty}`,
        );
      }
    } finally {
      await prisma.product.update({
        where: { id: MTG_TIN_ID },
        data: { stock: original.stock },
      });
    }
  });

  it('AD-6 concurrency guard: two concurrent checkouts on the same Product, each individually within stock but together exceeding it, resolve to exactly one 201 and one 409 — heldQty never exceeds stock (StockHold creation is atomically guarded)', async () => {
    // stock=15; 9 + 9 = 18 > 15, but 9 <= 15 individually — neither cart's
    // own add-to-cart (which does not hold stock, only checkout does, per
    // AD-6) has any reason to reject either request on its own.
    const [addA, addB] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: SV_BOOSTER_BOX_ID, quantity: 9 })
        .expect(201),
      request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: SV_BOOSTER_BOX_ID, quantity: 9 })
        .expect(201),
    ]);
    const cookieA = extractCartCookie(addA);
    const cookieB = extractCartCookie(addB);

    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Cookie', cookieA)
        .send(pickupBody()),
      request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Cookie', cookieB)
        .send(pickupBody()),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    if (statuses[0] !== 201 || statuses[1] !== 409) {
      throw new Error(
        `Expected exactly one 201 and one 409, got: ${JSON.stringify([resA.status, resB.status])} bodies=${JSON.stringify([resA.body, resB.body])}`,
      );
    }

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;
    const loserBody = loser.body as ApiErrorBody;
    if (loserBody.errorCode !== 'INSUFFICIENT_STOCK') {
      throw new Error(
        `Expected the losing checkout's errorCode to be INSUFFICIENT_STOCK, got: ${JSON.stringify(loserBody)}`,
      );
    }

    const winnerBody = winner.body as CheckoutResponse;
    try {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: SV_BOOSTER_BOX_ID },
      });
      // Exactly the WINNER's 9 units are held — never 18 (both), never 0
      // (neither) — the guard applied cleanly to exactly one of the two.
      if (product.heldQty !== 9) {
        throw new Error(
          `Expected heldQty=9 (only the winning checkout's hold), got ${product.heldQty}`,
        );
      }
      if (product.stock !== 15) {
        throw new Error(`Expected stock to stay 15, got ${product.stock}`);
      }

      const winnerOrder = await prisma.order.findUniqueOrThrow({
        where: { id: winnerBody.orderId },
        include: { stockHolds: true },
      });
      if (
        winnerOrder.stockHolds.length !== 1 ||
        winnerOrder.stockHolds[0].quantity !== 9
      ) {
        throw new Error(
          `Expected the winning Order to hold exactly 9 units, got: ${JSON.stringify(winnerOrder.stockHolds)}`,
        );
      }
    } finally {
      await cleanupOrder(winnerBody.orderId);
    }
  });
});
