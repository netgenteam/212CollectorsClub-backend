import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  PUBLIC_STATIC_PREFIX,
  UPLOADS_PUBLIC_ROOT,
} from './../src/admin-catalog/product-image-upload-paths.constants.js';

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
}

interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  priceUsd: number;
  stock: number;
  isActive: boolean;
  images: Array<{ id: string; url: string; sortOrder: number }>;
}

interface PublicProductDetail {
  id: string;
  name: string;
}

interface PaginatedPublicProducts {
  data: Array<{ id: string }>;
}

interface CheckoutResponse {
  orderId: string;
  orderAccessToken: string;
  lines: Array<{
    productId: string;
    productName: string;
    unitPriceUsd: number;
  }>;
}

interface OrderDetail {
  lines: Array<{
    productId: string;
    productName: string;
    unitPriceUsd: number;
  }>;
}

const TEST_USERNAME = 'e2e-admin-story-8-2';
const TEST_EMAIL = 'e2e-admin-story-8-2@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-8f2c';

// Story 1.4 seed data (prisma/seed.ts) — stable across environments.
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262'; // "ediciones-especiales"
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Story 8.2 (FR-22, NFR-3, NFR-4; AD-2, AD-11, AD-12). Full-stack e2e
 * coverage of the admin Product CRUD + image upload: guard-gating on all
 * verbs, negative price/stock rejection, immediate public visibility on
 * create (no cache, AD-10), the deactivate-vs-delete policy against a
 * Product with real historical Order references (confirming the
 * OrderLine snapshot survives untouched), and the additional-image upload
 * being reachable at a REAL public URL (unlike Story 4.2's private
 * proof-of-payment path). Mirrors `test/admin-categories.e2e-spec.ts`'s
 * structure/conventions closely.
 *
 * `app.useStaticAssets(...)` is called explicitly in `beforeEach` here
 * (not inherited from `main.ts`'s `bootstrap()`, which this suite — like
 * every other `*.e2e-spec.ts` in this repo — never actually calls) so the
 * "real public URL" assertions below exercise the exact same static-mount
 * config `main.ts` wires up in production.
 */
describe('AdminProductsController (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.useStaticAssets(UPLOADS_PUBLIC_ROOT, { prefix: PUBLIC_STATIC_PREFIX });

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

  function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function createProductRequest(overrides: Record<string, string> = {}) {
    const slug = overrides.slug ?? uniqueSlug('e2e-product');
    return authed('post', '/api/v1/admin/products')
      .field('name', overrides.name ?? 'E2E Test Product')
      .field('slug', slug)
      .field('description', 'A Product created by an e2e test.')
      .field('franchise', overrides.franchise ?? 'POKEMON')
      .field('productType', overrides.productType ?? 'SINGLE_CARD')
      .field('rarity', overrides.rarity ?? 'COMMON')
      .field('priceUsd', overrides.priceUsd ?? '19.99')
      .field('stock', overrides.stock ?? '10')
      .field('categoryId', overrides.categoryId ?? SEEDED_CATEGORY_ID)
      .attach('images', IMAGE_FIXTURE_PATH);
  }

  describe('AdminAuthGuard gating — no token on any of the 5 verbs', () => {
    it('POST /api/v1/admin/products: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .field('name', 'X')
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('GET /api/v1/admin/products: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('PATCH /api/v1/admin/products/:id: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${SEEDED_CATEGORY_ID}`)
        .send({ name: 'Should not apply' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('DELETE /api/v1/admin/products/:id: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${SEEDED_CATEGORY_ID}`)
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('POST /api/v1/admin/products/:id/images: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${SEEDED_CATEGORY_ID}/images`)
        .attach('images', IMAGE_FIXTURE_PATH)
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });
  });

  describe('POST /api/v1/admin/products', () => {
    it('with Franchise/ProductType/Rarity/price/stock/category and an image: creates the Product, and it is IMMEDIATELY visible via the public GET /api/v1/products and /products/:id (Epic 2)', async () => {
      const slug = uniqueSlug('e2e-visible');
      const createRes = await createProductRequest({ slug }).expect(201);
      const created = createRes.body as AdminProduct;
      expect(created.slug).toBe(slug);
      expect(created.isActive).toBe(true);
      expect(created.images).toHaveLength(1);

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/products/${created.id}`)
        .expect(200);
      expect((detailRes.body as PublicProductDetail).id).toBe(created.id);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/products?limit=100')
        .expect(200);
      expect(
        (listRes.body as PaginatedPublicProducts).data.some(
          (p) => p.id === created.id,
        ),
      ).toBe(true);

      await authed('delete', `/api/v1/admin/products/${created.id}`).expect(
        200,
      );
    });

    it('no image file sent: 400 PRODUCT_IMAGE_REQUIRED, never persisted', async () => {
      const slug = uniqueSlug('e2e-no-image');
      const res = await authed('post', '/api/v1/admin/products')
        .field('name', 'No Image Product')
        .field('slug', slug)
        .field('description', 'Should be rejected.')
        .field('franchise', 'POKEMON')
        .field('productType', 'SINGLE_CARD')
        .field('rarity', 'COMMON')
        .field('priceUsd', '9.99')
        .field('stock', '1')
        .field('categoryId', SEEDED_CATEGORY_ID)
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'PRODUCT_IMAGE_REQUIRED',
      );

      const found = await prisma.product.findUnique({ where: { slug } });
      expect(found).toBeNull();
    });

    it('a negative price: 400, never persisted', async () => {
      const slug = uniqueSlug('e2e-negative-price');
      await createProductRequest({ slug, priceUsd: '-5.00' }).expect(400);

      const found = await prisma.product.findUnique({ where: { slug } });
      expect(found).toBeNull();
    });

    it('a negative stock: 400, never persisted', async () => {
      const slug = uniqueSlug('e2e-negative-stock');
      await createProductRequest({ slug, stock: '-1' }).expect(400);

      const found = await prisma.product.findUnique({ where: { slug } });
      expect(found).toBeNull();
    });

    it('a slug already in use (even by a seeded Product): 409 PRODUCT_SLUG_TAKEN, never a raw 500', async () => {
      const res = await createProductRequest({
        slug: 'charizard-vmax', // seeded Story 1.4 slug
      }).expect(409);
      expect((res.body as ApiErrorBody).errorCode).toBe('PRODUCT_SLUG_TAKEN');
    });

    it('an unknown categoryId: 400 CATEGORY_NOT_FOUND, never persisted', async () => {
      const slug = uniqueSlug('e2e-bad-category');
      const res = await createProductRequest({
        slug,
        categoryId: '00000000-0000-0000-0000-000000000000',
      }).expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe('CATEGORY_NOT_FOUND');

      const found = await prisma.product.findUnique({ where: { slug } });
      expect(found).toBeNull();
    });
  });

  describe('deactivate vs. delete — a Product with a real historical Order', () => {
    async function checkoutSingleProduct(productId: string): Promise<{
      orderId: string;
      orderAccessToken: string;
      snapshotName: string;
      snapshotPrice: number;
    }> {
      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .send({ productId, quantity: 1 })
        .expect(201);
      const setCookie = addRes.headers['set-cookie'] as unknown as
        string[] | undefined;
      const cartCookie = setCookie?.find((c) => c.startsWith('cartId='));
      if (!cartCookie) {
        throw new Error(
          'Expected a cartId Set-Cookie header from POST /cart/items',
        );
      }

      const checkoutRes = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Cookie', cartCookie)
        .send({
          paymentRail: 'pago_movil',
          fulfillmentType: 'pickup',
          recipientName: 'Maria Perez',
          recipientPhone: '0412-1234567',
        })
        .expect(201);
      const body = checkoutRes.body as CheckoutResponse;
      return {
        orderId: body.orderId,
        orderAccessToken: body.orderAccessToken,
        snapshotName: body.lines[0].productName,
        snapshotPrice: body.lines[0].unitPriceUsd,
      };
    }

    async function cleanupOrder(orderId: string): Promise<void> {
      const holds = await prisma.stockHold.findMany({
        where: { orderId },
        select: { productId: true, quantity: true },
      });
      for (const hold of holds) {
        await prisma.product
          .update({
            where: { id: hold.productId },
            data: { heldQty: { decrement: hold.quantity } },
          })
          .catch(() => undefined);
      }
      await prisma.order
        .delete({ where: { id: orderId } })
        .catch(() => undefined);
    }

    it("PATCH { isActive: false } on a Product with a historical Order: disappears from public catalog, but that Order's OrderLine snapshot stays intact", async () => {
      const slug = uniqueSlug('e2e-deactivate-history');
      const createRes = await createProductRequest({
        slug,
        name: 'Deactivate-With-History Product',
        priceUsd: '33.33',
        stock: '5',
      }).expect(201);
      const created = createRes.body as AdminProduct;

      const order = await checkoutSingleProduct(created.id);

      try {
        await authed('patch', `/api/v1/admin/products/${created.id}`)
          .send({ isActive: false })
          .expect(200);

        // Gone from public catalog...
        await request(app.getHttpServer())
          .get(`/api/v1/products/${created.id}`)
          .expect(404);
        const listRes = await request(app.getHttpServer())
          .get('/api/v1/products?limit=100')
          .expect(200);
        expect(
          (listRes.body as PaginatedPublicProducts).data.some(
            (p) => p.id === created.id,
          ),
        ).toBe(false);

        // ...but still fully visible/editable in the admin listing...
        await authed('get', `/api/v1/admin/products/${created.id}`)
          .expect(200)
          .expect((res) => {
            const body = res.body as AdminProduct;
            if (body.isActive !== false) {
              throw new Error(
                `Expected isActive=false, got ${String(body.isActive)}`,
              );
            }
          });

        // ...and the PAST Order's OrderLine snapshot is completely
        // unaffected — same productName/unitPriceUsd captured at
        // checkout time, read back via the buyer-facing order lookup
        // (Story 5.1).
        const orderRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${order.orderId}`)
          .set('Authorization', `Bearer ${order.orderAccessToken}`)
          .expect(200);
        const orderBody = orderRes.body as OrderDetail;
        expect(orderBody.lines[0].productName).toBe(order.snapshotName);
        expect(orderBody.lines[0].unitPriceUsd).toBe(order.snapshotPrice);
        expect(orderBody.lines[0].productName).toBe(
          'Deactivate-With-History Product',
        );
      } finally {
        await cleanupOrder(order.orderId);
        await authed('delete', `/api/v1/admin/products/${created.id}`);
      }
    });

    it('DELETE on a Product with a historical OrderLine: Postgres rejects the real delete (FK), falls back to isActive=false — hardDeleted: false, OrderLine untouched', async () => {
      const slug = uniqueSlug('e2e-delete-with-history');
      const createRes = await createProductRequest({ slug }).expect(201);
      const created = createRes.body as AdminProduct;

      const order = await checkoutSingleProduct(created.id);

      try {
        const deleteRes = await authed(
          'delete',
          `/api/v1/admin/products/${created.id}`,
        ).expect(200);
        expect(deleteRes.body).toEqual({ id: created.id, hardDeleted: false });

        // The Product row still exists (deactivated), never actually
        // deleted — confirmed via the admin GET.
        const adminGetRes = await authed(
          'get',
          `/api/v1/admin/products/${created.id}`,
        ).expect(200);
        expect((adminGetRes.body as AdminProduct).isActive).toBe(false);

        // The historical Order's OrderLine is completely untouched.
        const orderRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${order.orderId}`)
          .set('Authorization', `Bearer ${order.orderAccessToken}`)
          .expect(200);
        expect((orderRes.body as OrderDetail).lines[0].productId).toBe(
          created.id,
        );
      } finally {
        await cleanupOrder(order.orderId);
        // The Order (and its OrderLine) is gone now, so the FK that
        // forced the fallback above no longer applies — a real delete
        // succeeds, leaving no leftover row behind for other test runs.
        await authed('delete', `/api/v1/admin/products/${created.id}`).catch(
          () => undefined,
        );
      }
    });

    it('DELETE on a Product with NO historical references: real delete succeeds — hardDeleted: true, then 404 everywhere', async () => {
      const slug = uniqueSlug('e2e-delete-no-history');
      const createRes = await createProductRequest({ slug }).expect(201);
      const created = createRes.body as AdminProduct;

      const deleteRes = await authed(
        'delete',
        `/api/v1/admin/products/${created.id}`,
      ).expect(200);
      expect(deleteRes.body).toEqual({ id: created.id, hardDeleted: true });

      await authed('get', `/api/v1/admin/products/${created.id}`).expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/products/${created.id}`)
        .expect(404);
    });
  });

  describe('POST /api/v1/admin/products/:id/images', () => {
    it("adds a new ProductImage, and the file is reachable at a REAL public URL (unlike Story 4.2's private proof-of-payment path)", async () => {
      const slug = uniqueSlug('e2e-add-image');
      const createRes = await createProductRequest({ slug }).expect(201);
      const created = createRes.body as AdminProduct;
      expect(created.images).toHaveLength(1);

      try {
        const addImageRes = await authed(
          'post',
          `/api/v1/admin/products/${created.id}/images`,
        )
          .attach('images', IMAGE_FIXTURE_PATH)
          .expect(201);
        const updated = addImageRes.body as AdminProduct;
        expect(updated.images).toHaveLength(2);
        expect(updated.images[1].sortOrder).toBe(1);

        const newImageUrl = updated.images[1].url;
        expect(newImageUrl).toMatch(/^\/uploads\/public\/products\//);

        // The actual, no-token-required public fetch — this is the whole
        // point of AD-12 for this story (contrast with 4.2's private
        // root, which has no equivalent public route at all).
        const fileRes = await request(app.getHttpServer())
          .get(newImageUrl)
          .expect(200);
        expect(fileRes.headers['content-type']).toMatch(/^image\/png/);
        expect(Number(fileRes.headers['content-length'])).toBeGreaterThan(0);
      } finally {
        await authed('delete', `/api/v1/admin/products/${created.id}`);
      }
    });

    it('no image file sent: 400 PRODUCT_IMAGE_REQUIRED', async () => {
      const slug = uniqueSlug('e2e-add-image-empty');
      const createRes = await createProductRequest({ slug }).expect(201);
      const created = createRes.body as AdminProduct;

      try {
        const res = await authed(
          'post',
          `/api/v1/admin/products/${created.id}/images`,
        ).expect(400);
        expect((res.body as ApiErrorBody).errorCode).toBe(
          'PRODUCT_IMAGE_REQUIRED',
        );
      } finally {
        await authed('delete', `/api/v1/admin/products/${created.id}`);
      }
    });

    it('an unknown Product id: 404, and the already-uploaded file never ends up linked to anything', async () => {
      await authed(
        'post',
        '/api/v1/admin/products/00000000-0000-0000-0000-000000000000/images',
      )
        .attach('images', IMAGE_FIXTURE_PATH)
        .expect(404);
    });
  });

  describe('PATCH /api/v1/admin/products/:id/stock', () => {
    it('401 INVALID_ADMIN_TOKEN with no token', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${SEEDED_CATEGORY_ID}/stock`)
        .send({ stock: 5 })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('a valid adjustment: updates Product.stock directly, reflected IMMEDIATELY in the public catalog list/detail (no cache, AD-10), and never touches heldQty/StockHold/OrderStatusHistory', async () => {
      const slug = uniqueSlug('e2e-stock-adjust');
      const createRes = await createProductRequest({
        slug,
        stock: '10',
      }).expect(201);
      const created = createRes.body as AdminProduct;

      try {
        const beforeRow = await prisma.product.findUniqueOrThrow({
          where: { id: created.id },
          select: { heldQty: true },
        });
        const beforeHoldCount = await prisma.stockHold.count({
          where: { productId: created.id },
        });
        const beforeHistoryCount = await prisma.orderStatusHistory.count();

        const patchRes = await authed(
          'patch',
          `/api/v1/admin/products/${created.id}/stock`,
        )
          .send({ stock: 42 })
          .expect(200);
        expect((patchRes.body as AdminProduct).stock).toBe(42);

        // Immediately, no delay: public detail AND public list both show
        // the corrected availableStock straight away.
        const detailRes = await request(app.getHttpServer())
          .get(`/api/v1/products/${created.id}`)
          .expect(200);
        expect(
          (detailRes.body as { availableStock: number }).availableStock,
        ).toBe(42);

        const listRes = await request(app.getHttpServer())
          .get('/api/v1/products?limit=100')
          .expect(200);
        const listedRow = (
          listRes.body as {
            data: Array<{ id: string; availableStock: number }>;
          }
        ).data.find((p) => p.id === created.id);
        expect(listedRow?.availableStock).toBe(42);

        // Real Postgres check: heldQty untouched, no StockHold/
        // OrderStatusHistory row was created by this adjustment.
        const afterRow = await prisma.product.findUniqueOrThrow({
          where: { id: created.id },
          select: { heldQty: true, stock: true },
        });
        expect(afterRow.stock).toBe(42);
        expect(afterRow.heldQty).toBe(beforeRow.heldQty);
        const afterHoldCount = await prisma.stockHold.count({
          where: { productId: created.id },
        });
        expect(afterHoldCount).toBe(beforeHoldCount);
        const afterHistoryCount = await prisma.orderStatusHistory.count();
        expect(afterHistoryCount).toBe(beforeHistoryCount);
      } finally {
        await authed('delete', `/api/v1/admin/products/${created.id}`);
      }
    });

    it('a negative stock value: 400, never persisted', async () => {
      const slug = uniqueSlug('e2e-stock-negative');
      const createRes = await createProductRequest({
        slug,
        stock: '7',
      }).expect(201);
      const created = createRes.body as AdminProduct;

      try {
        await authed('patch', `/api/v1/admin/products/${created.id}/stock`)
          .send({ stock: -1 })
          .expect(400);

        const unchanged = await prisma.product.findUniqueOrThrow({
          where: { id: created.id },
          select: { stock: true },
        });
        expect(unchanged.stock).toBe(7);
      } finally {
        await authed('delete', `/api/v1/admin/products/${created.id}`);
      }
    });

    it('an unknown Product id: 404', async () => {
      await authed(
        'patch',
        '/api/v1/admin/products/00000000-0000-0000-0000-000000000000/stock',
      )
        .send({ stock: 5 })
        .expect(404);
    });
  });
});
