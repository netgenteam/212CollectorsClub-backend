import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface CartItemResponse {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  lineTotal: number;
}

interface CartResponse {
  items: CartItemResponse[];
  total: number;
}

// Seeded Products (Story 1.4, prisma/seed.ts) reused read-only or with a
// mutate-then-restore pattern (mirrors products.e2e-spec.ts's stock
// staleness test) rather than creating throwaway fixtures.
const PIKACHU_PROMO_ID = '343c080e-6b92-48d0-9369-6cee233cf673'; // stock 40
const LUFFY_LEADER_ID = '76f4d753-8142-417e-ba0f-f0c426369a8d'; // stock 8
const CHARIZARD_VMAX_ID = 'f65915f5-2931-4e50-af95-630b1fd7b950'; // stock 12
// Story 3.2: distinct Products from the ones Story 3.1's tests above
// already mutate/read (Charizard VMAX's price, Luffy's stock boundary) so
// this file's own tests can't flake against those in a parallel run.
const BLUE_EYES_ID = '0992a698-3b4f-446e-9fc0-22fb4fe8847a'; // stock 25
const YUGIOH_BOX_ID = 'f45cfd6e-43b0-40f3-93e1-49d4d60741ba'; // stock 10

// Pulls the raw `cartId=...` Set-Cookie header string out of a response so
// it can be replayed on a follow-up request via `.set('Cookie', ...)` —
// the cookie is HttpOnly, so it must be forwarded explicitly like this
// rather than relying on a browser-style automatic cookie jar.
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

// Runs against the shared dev Postgres seeded by Story 1.4 (prisma/seed.ts),
// same as catalog/products.e2e-spec.ts.
describe('CartController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirrors main.ts bootstrap (Story 3.1 adds cookie-parser, given the
    // AD-5 COOKIE_SECRET, ahead of the Story 1.2 prefix/versioning setup
    // every other e2e spec already replicates).
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
  });

  it('GET /api/v1/cart with no cart cookie returns an empty cart, not an error', () => {
    return request(app.getHttpServer())
      .get('/api/v1/cart')
      .expect(200)
      .expect((res) => {
        const body = res.body as CartResponse;
        if (body.items.length !== 0 || body.total !== 0) {
          throw new Error(
            `Expected an empty cart, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('POST /api/v1/cart/items with no existing cart cookie creates a new Cart, sets an HttpOnly/Secure-flagged/SameSite=Lax signed cartId cookie, and creates the CartItem (FR-8, AD-5)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: PIKACHU_PROMO_ID, quantity: 2 })
      .expect(201);

    const cartCookie = extractCartCookie(res);
    // Attribute assertions on the raw Set-Cookie string — supertest/
    // superagent doesn't expose parsed cookie flags directly.
    if (!/HttpOnly/i.test(cartCookie)) {
      throw new Error(`Expected HttpOnly on cartId cookie: ${cartCookie}`);
    }
    if (!/SameSite=Lax/i.test(cartCookie)) {
      throw new Error(`Expected SameSite=Lax on cartId cookie: ${cartCookie}`);
    }
    // Signed cookie-parser values are prefixed "s:" before signing/encoding
    // — asserting the cookie is NOT the raw cartId (a bare uuid) is a cheap
    // proxy for "this went through signing", without depending on the
    // exact wire encoding.
    if (cartCookie.includes(PIKACHU_PROMO_ID)) {
      throw new Error(
        `Expected the cartId cookie value to be opaque/signed, not the productId leaking through: ${cartCookie}`,
      );
    }

    const body = res.body as CartResponse;
    if (
      body.items.length !== 1 ||
      body.items[0].productId !== PIKACHU_PROMO_ID
    ) {
      throw new Error(
        `Expected one CartItem for the added Product, got: ${JSON.stringify(body)}`,
      );
    }
    if (body.items[0].quantity !== 2) {
      throw new Error(
        `Expected quantity 2, got: ${JSON.stringify(body.items[0])}`,
      );
    }
  });

  it('a second POST /api/v1/cart/items carrying the cartId cookie reuses the SAME Cart (not a new one) across both an existing and a new product', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: PIKACHU_PROMO_ID, quantity: 1 })
      .expect(201);
    const cartCookie = extractCartCookie(first);

    const second = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Cookie', cartCookie)
      .send({ productId: LUFFY_LEADER_ID, quantity: 1 })
      .expect(201);

    const body = second.body as CartResponse;
    if (body.items.length !== 2) {
      throw new Error(
        `Expected both products in the same cart after reusing the cookie, got: ${JSON.stringify(body)}`,
      );
    }
    const productIds = body.items.map((i) => i.productId).sort();
    if (
      JSON.stringify(productIds) !==
      JSON.stringify([LUFFY_LEADER_ID, PIKACHU_PROMO_ID].sort())
    ) {
      throw new Error(`Unexpected items in cart: ${JSON.stringify(body)}`);
    }

    // GET with the same cookie shows both, and the total is the sum of
    // both lines' current price * quantity.
    const getRes = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Cookie', cartCookie)
      .expect(200);
    const getBody = getRes.body as CartResponse;
    if (getBody.items.length !== 2) {
      throw new Error(
        `Expected GET /cart to show both items, got: ${JSON.stringify(getBody)}`,
      );
    }
    const expectedTotal =
      Math.round(
        getBody.items.reduce((sum, item) => sum + item.lineTotal, 0) * 100,
      ) / 100;
    if (getBody.total !== expectedTotal) {
      throw new Error(`Expected total ${expectedTotal}, got ${getBody.total}`);
    }
  });

  it('re-adding the same Product increases the existing line quantity instead of creating a duplicate line', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: PIKACHU_PROMO_ID, quantity: 1 })
      .expect(201);
    const cartCookie = extractCartCookie(first);

    const second = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Cookie', cartCookie)
      .send({ productId: PIKACHU_PROMO_ID, quantity: 3 })
      .expect(201);

    const body = second.body as CartResponse;
    if (body.items.length !== 1) {
      throw new Error(
        `Expected a single merged line, got: ${JSON.stringify(body)}`,
      );
    }
    if (body.items[0].quantity !== 4) {
      throw new Error(
        `Expected merged quantity 4 (1 + 3), got: ${JSON.stringify(body.items[0])}`,
      );
    }
  });

  it('rejects with 409 INSUFFICIENT_STOCK and the real current available stock when requested quantity exceeds it (never silently clamped/accepted)', async () => {
    const prisma = app.get(PrismaService);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: LUFFY_LEADER_ID },
      select: { stock: true, heldQty: true },
    });
    const availableStock = product.stock - product.heldQty;

    return request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: LUFFY_LEADER_ID, quantity: availableStock + 1000 })
      .expect(409)
      .expect((res) => {
        const body = res.body as {
          errorCode: string;
          details: { availableStock: number };
        };
        if (body.errorCode !== 'INSUFFICIENT_STOCK') {
          throw new Error(
            `Expected errorCode INSUFFICIENT_STOCK, got: ${JSON.stringify(body)}`,
          );
        }
        if (body.details.availableStock !== availableStock) {
          throw new Error(
            `Expected details.availableStock ${availableStock}, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('GET /api/v1/cart reflects a Product priceUsd change made directly in Postgres between add-to-cart and the read, never a stale/cached price (FR-11)', async () => {
    const prisma = app.get(PrismaService);
    const original = await prisma.product.findUniqueOrThrow({
      where: { id: CHARIZARD_VMAX_ID },
      select: { priceUsd: true },
    });

    const addRes = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .send({ productId: CHARIZARD_VMAX_ID, quantity: 1 })
      .expect(201);
    const cartCookie = extractCartCookie(addRes);
    const addedPrice = (addRes.body as CartResponse).items[0].price;

    try {
      const newPrice = (Number(original.priceUsd) + 25).toFixed(2);
      await prisma.product.update({
        where: { id: CHARIZARD_VMAX_ID },
        data: { priceUsd: newPrice },
      });

      const getRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Cookie', cartCookie)
        .expect(200);
      const body = getRes.body as CartResponse;
      const item = body.items.find((i) => i.productId === CHARIZARD_VMAX_ID);
      if (!item) {
        throw new Error(
          `Expected the item in the cart, got: ${JSON.stringify(body)}`,
        );
      }
      if (item.price === addedPrice) {
        throw new Error(
          `Expected the price to change after a direct DB update, stayed at ${addedPrice}`,
        );
      }
      if (item.price !== Number(newPrice)) {
        throw new Error(
          `Expected price ${newPrice}, got ${item.price} — looks like a stale/cached price`,
        );
      }
      if (item.lineTotal !== item.price * item.quantity) {
        throw new Error(
          `Expected lineTotal to be recomputed from the new price, got: ${JSON.stringify(item)}`,
        );
      }
    } finally {
      await prisma.product.update({
        where: { id: CHARIZARD_VMAX_ID },
        data: { priceUsd: original.priceUsd },
      });
    }
  });

  describe('PATCH /api/v1/cart/items/:productId (Story 3.2)', () => {
    it('updates the quantity, and the response (and a follow-up GET) reflect the new quantity and recalculated total', async () => {
      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: BLUE_EYES_ID, quantity: 2 })
        .expect(201);
      const cartCookie = extractCartCookie(addRes);
      const price = (addRes.body as CartResponse).items[0].price;

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${BLUE_EYES_ID}`)
        .set('Cookie', cartCookie)
        .send({ quantity: 5 })
        .expect(200);
      const patchBody = patchRes.body as CartResponse;
      const patchedItem = patchBody.items.find(
        (i) => i.productId === BLUE_EYES_ID,
      );
      if (!patchedItem || patchedItem.quantity !== 5) {
        throw new Error(
          `Expected quantity 5 after PATCH, got: ${JSON.stringify(patchBody)}`,
        );
      }
      const expectedLineTotal = Math.round(price * 5 * 100) / 100;
      if (patchedItem.lineTotal !== expectedLineTotal) {
        throw new Error(
          `Expected lineTotal ${expectedLineTotal}, got ${patchedItem.lineTotal}`,
        );
      }

      const getRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Cookie', cartCookie)
        .expect(200);
      const getBody = getRes.body as CartResponse;
      const getItem = getBody.items.find((i) => i.productId === BLUE_EYES_ID);
      if (!getItem || getItem.quantity !== 5) {
        throw new Error(
          `Expected GET /cart to reflect quantity 5, got: ${JSON.stringify(getBody)}`,
        );
      }
      if (getBody.total !== patchBody.total) {
        throw new Error(
          `Expected GET /cart total (${getBody.total}) to match the PATCH response total (${patchBody.total})`,
        );
      }
    });

    it('quantity=0 removes the CartItem entirely — the PATCH response and a follow-up GET both stop showing it', async () => {
      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: YUGIOH_BOX_ID, quantity: 3 })
        .expect(201);
      const cartCookie = extractCartCookie(addRes);

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${YUGIOH_BOX_ID}`)
        .set('Cookie', cartCookie)
        .send({ quantity: 0 })
        .expect(200);
      const patchBody = patchRes.body as CartResponse;
      if (patchBody.items.some((i) => i.productId === YUGIOH_BOX_ID)) {
        throw new Error(
          `Expected the item to be gone from the PATCH response, got: ${JSON.stringify(patchBody)}`,
        );
      }

      const getRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Cookie', cartCookie)
        .expect(200);
      const getBody = getRes.body as CartResponse;
      if (getBody.items.some((i) => i.productId === YUGIOH_BOX_ID)) {
        throw new Error(
          `Expected GET /cart to no longer show the item, got: ${JSON.stringify(getBody)}`,
        );
      }
    });

    it('rejects with 409 INSUFFICIENT_STOCK and the real current available stock when the new quantity exceeds it, leaving the cart unmodified', async () => {
      const prisma = app.get(PrismaService);
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: YUGIOH_BOX_ID },
        select: { stock: true, heldQty: true },
      });
      const availableStock = product.stock - product.heldQty;

      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: YUGIOH_BOX_ID, quantity: 3 })
        .expect(201);
      const cartCookie = extractCartCookie(addRes);

      await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${YUGIOH_BOX_ID}`)
        .set('Cookie', cartCookie)
        .send({ quantity: availableStock + 1000 })
        .expect(409)
        .expect((res) => {
          const body = res.body as {
            errorCode: string;
            details: { availableStock: number };
          };
          if (body.errorCode !== 'INSUFFICIENT_STOCK') {
            throw new Error(
              `Expected errorCode INSUFFICIENT_STOCK, got: ${JSON.stringify(body)}`,
            );
          }
          if (body.details.availableStock !== availableStock) {
            throw new Error(
              `Expected details.availableStock ${availableStock}, got: ${JSON.stringify(body)}`,
            );
          }
        });

      // The cart must be left exactly as it was before the rejected PATCH —
      // still quantity 3, not the rejected value and not removed.
      const getRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Cookie', cartCookie)
        .expect(200);
      const getBody = getRes.body as CartResponse;
      const item = getBody.items.find((i) => i.productId === YUGIOH_BOX_ID);
      if (!item || item.quantity !== 3) {
        throw new Error(
          `Expected the cart to be unmodified (quantity still 3), got: ${JSON.stringify(getBody)}`,
        );
      }
    });

    it('returns 404 when there is no cart cookie at all', () => {
      return request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${PIKACHU_PROMO_ID}`)
        .send({ quantity: 2 })
        .expect(404);
    });

    it('returns 404 when the cart cookie is valid but the given productId is not a line in that cart', async () => {
      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId: PIKACHU_PROMO_ID, quantity: 1 })
        .expect(201);
      const cartCookie = extractCartCookie(addRes);

      return request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${BLUE_EYES_ID}`) // never added to this cart
        .set('Cookie', cartCookie)
        .send({ quantity: 2 })
        .expect(404);
    });

    it('returns a stable 400 (never a 500) for a syntactically invalid productId', () => {
      return request(app.getHttpServer())
        .patch('/api/v1/cart/items/not-a-valid-uuid')
        .send({ quantity: 2 })
        .expect(400);
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
