import { randomUUID } from 'node:crypto';
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

interface CategoryResponse {
  id: string;
  name: string;
  slug: string;
}

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
}

const TEST_USERNAME = 'e2e-admin-story-8-1';
const TEST_EMAIL = 'e2e-admin-story-8-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-8f1c';

// Story 1.4 seed data (prisma/seed.ts) — stable across environments since
// every seeded row carries a fixed, hardcoded id/slug.
const SEEDED_CATEGORY_WITH_PRODUCTS = {
  id: '7bfd9c58-b7c4-490c-8232-6a463b87c262',
  slug: 'ediciones-especiales',
};
const SEEDED_PRODUCT_IN_THAT_CATEGORY = {
  id: 'c1701d9e-5fd2-4083-98f2-ce751d7ed64b',
  slug: 'mtg-black-lotus-reprint-tin',
};
const SEEDED_TAKEN_SLUG = 'sobres-y-cajas';

/**
 * Story 8.1 (FR-23, NFR-3, NFR-4; AD-2, AD-11). Full-stack e2e coverage
 * (real guard, real Postgres — the seeded dev DB from Story 1.4) of the
 * admin Category CRUD: guard-gating on all 4 verbs, immediate visibility on
 * the public catalog endpoint (no cache, AD-10), the 409 CATEGORY_IN_USE
 * delete policy (AD-2) and the 409 CATEGORY_SLUG_TAKEN unique-slug
 * conflict. Prisma-error-translation branch coverage (P2002/P2003/P2025)
 * lives in `admin-categories.service.spec.ts` against a mocked
 * PrismaService — this suite is about the real end-to-end wiring, not
 * re-deriving those same branches against a mock.
 */
describe('AdminCategoriesController (e2e)', () => {
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

  function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  describe('AdminAuthGuard gating — no token on any of the 4 verbs', () => {
    it('POST /api/v1/admin/categories: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .send({ name: 'X', slug: 'x' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('GET /api/v1/admin/categories: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/categories')
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('PATCH /api/v1/admin/categories/:id: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/categories/${SEEDED_CATEGORY_WITH_PRODUCTS.id}`)
        .send({ name: 'Should not apply' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('DELETE /api/v1/admin/categories/:id: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/categories/${SEEDED_CATEGORY_WITH_PRODUCTS.id}`)
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });
  });

  describe('POST /api/v1/admin/categories', () => {
    it('with a valid JWT: creates the Category and it is IMMEDIATELY visible via public GET /api/v1/categories (no cache, AD-10)', async () => {
      const slug = `e2e-created-${randomUUID()}`;
      const createRes = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'E2E Created Category', slug })
        .expect(201);
      const created = createRes.body as CategoryResponse;
      expect(created.name).toBe('E2E Created Category');
      expect(created.slug).toBe(slug);
      expect(created.id).toBeTruthy();

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);
      const publicSlugs = (publicRes.body as CategoryResponse[]).map(
        (c) => c.slug,
      );
      expect(publicSlugs).toContain(slug);

      // Cleanup — this Category has no Products, delete succeeds.
      await authed('delete', `/api/v1/admin/categories/${created.id}`).expect(
        204,
      );
    });

    it('a slug already in use (even by a seeded Category): 409 CATEGORY_SLUG_TAKEN, never a raw 500', async () => {
      const res = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'Duplicate Slug Attempt', slug: SEEDED_TAKEN_SLUG })
        .expect(409);
      expect((res.body as ApiErrorBody).errorCode).toBe('CATEGORY_SLUG_TAKEN');
    });

    it('an invalid slug shape (uppercase/spaces): 400, never persisted', async () => {
      await authed('post', '/api/v1/admin/categories')
        .send({ name: 'Bad Slug', slug: 'Not A Valid Slug!' })
        .expect(400);
    });
  });

  describe('GET /api/v1/admin/categories and /api/v1/admin/categories/:id', () => {
    it('list includes the seeded Categories', async () => {
      const res = await authed('get', '/api/v1/admin/categories').expect(200);
      const slugs = (res.body as CategoryResponse[]).map((c) => c.slug);
      expect(slugs).toContain(SEEDED_CATEGORY_WITH_PRODUCTS.slug);
    });

    it('get by id returns the seeded Category', async () => {
      const res = await authed(
        'get',
        `/api/v1/admin/categories/${SEEDED_CATEGORY_WITH_PRODUCTS.id}`,
      ).expect(200);
      expect((res.body as CategoryResponse).slug).toBe(
        SEEDED_CATEGORY_WITH_PRODUCTS.slug,
      );
    });

    it('get by an unknown (but valid) id: 404', async () => {
      await authed(
        'get',
        '/api/v1/admin/categories/00000000-0000-0000-0000-000000000000',
      ).expect(404);
    });

    it('get by a syntactically invalid id: 400 (ParseUUIDPipe, never reaches Prisma)', async () => {
      await authed('get', '/api/v1/admin/categories/not-a-uuid').expect(400);
    });
  });

  describe('PATCH /api/v1/admin/categories/:id', () => {
    it('updates name/slug and the change is reflected in subsequent public reads', async () => {
      const originalSlug = `e2e-patch-${randomUUID()}`;
      const createRes = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'Before Patch', slug: originalSlug })
        .expect(201);
      const created = createRes.body as CategoryResponse;

      const newSlug = `e2e-patch-updated-${randomUUID()}`;
      const patchRes = await authed(
        'patch',
        `/api/v1/admin/categories/${created.id}`,
      )
        .send({ name: 'After Patch', slug: newSlug })
        .expect(200);
      const patched = patchRes.body as CategoryResponse;
      expect(patched.name).toBe('After Patch');
      expect(patched.slug).toBe(newSlug);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);
      const publicCategories = publicRes.body as CategoryResponse[];
      expect(publicCategories.some((c) => c.slug === newSlug)).toBe(true);
      expect(publicCategories.some((c) => c.slug === originalSlug)).toBe(false);

      await authed('delete', `/api/v1/admin/categories/${created.id}`).expect(
        204,
      );
    });

    it('renaming the slug to one already taken by another Category: 409 CATEGORY_SLUG_TAKEN', async () => {
      const slug = `e2e-conflict-${randomUUID()}`;
      const createRes = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'Conflict Candidate', slug })
        .expect(201);
      const created = createRes.body as CategoryResponse;

      const res = await authed(
        'patch',
        `/api/v1/admin/categories/${created.id}`,
      )
        .send({ slug: SEEDED_TAKEN_SLUG })
        .expect(409);
      expect((res.body as ApiErrorBody).errorCode).toBe('CATEGORY_SLUG_TAKEN');

      await authed('delete', `/api/v1/admin/categories/${created.id}`).expect(
        204,
      );
    });

    it('an unknown id: 404', async () => {
      await authed(
        'patch',
        '/api/v1/admin/categories/00000000-0000-0000-0000-000000000000',
      )
        .send({ name: 'Nope' })
        .expect(404);
    });
  });

  describe('DELETE /api/v1/admin/categories/:id (AD-2)', () => {
    it('a Category referenced by >=1 Product: 409 CATEGORY_IN_USE, never orphans the Product, never 500s', async () => {
      const res = await authed(
        'delete',
        `/api/v1/admin/categories/${SEEDED_CATEGORY_WITH_PRODUCTS.id}`,
      ).expect(409);
      expect((res.body as ApiErrorBody).errorCode).toBe('CATEGORY_IN_USE');

      // The Category itself is untouched...
      await authed(
        'get',
        `/api/v1/admin/categories/${SEEDED_CATEGORY_WITH_PRODUCTS.id}`,
      ).expect(200);

      // ...and the Product that references it is intact, still pointing at
      // the same (non-orphaned) Category, via the PUBLIC product-detail
      // endpoint (Story 2.3) — nothing silently nulled/broken.
      const productRes = await request(app.getHttpServer())
        .get(`/api/v1/products/${SEEDED_PRODUCT_IN_THAT_CATEGORY.id}`)
        .expect(200);
      const product = productRes.body as {
        slug: string;
        category: { id: string };
      };
      expect(product.slug).toBe(SEEDED_PRODUCT_IN_THAT_CATEGORY.slug);
      expect(product.category.id).toBe(SEEDED_CATEGORY_WITH_PRODUCTS.id);
    });

    it('a Category with no Products: succeeds, and it disappears from both the admin and public listings', async () => {
      const slug = `e2e-delete-${randomUUID()}`;
      const createRes = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'To Be Deleted', slug })
        .expect(201);
      const created = createRes.body as CategoryResponse;

      await authed('delete', `/api/v1/admin/categories/${created.id}`).expect(
        204,
      );

      await authed('get', `/api/v1/admin/categories/${created.id}`).expect(404);

      const adminListRes = await authed(
        'get',
        '/api/v1/admin/categories',
      ).expect(200);
      expect(
        (adminListRes.body as CategoryResponse[]).some(
          (c) => c.id === created.id,
        ),
      ).toBe(false);

      const publicListRes = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);
      expect(
        (publicListRes.body as CategoryResponse[]).some(
          (c) => c.id === created.id,
        ),
      ).toBe(false);
    });

    it('an unknown id: 404', async () => {
      await authed(
        'delete',
        '/api/v1/admin/categories/00000000-0000-0000-0000-000000000000',
      ).expect(404);
    });
  });
});
