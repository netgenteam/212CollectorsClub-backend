import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';

type App = Parameters<typeof request>[0];

interface ProductListItem {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
  availableStock: number;
  franchise: string;
  productType: string;
  rarity: string;
  primaryImage: { url: string; altText: string | null } | null;
}

interface PaginatedProducts {
  data: ProductListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

// Runs against the shared dev Postgres seeded by Story 1.4 (prisma/seed.ts),
// same as catalog.e2e-spec.ts — it always has the 10 seeded Products, so
// search/filter ACs are exercised against real, known data (e.g. the
// seeded "Charizard VMAX" Product) rather than fixtures created here.
describe('ProductsController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirrors main.ts bootstrap (Stories 1.2/2.2): global "/api" prefix +
    // URI versioning with default version "1", plus the global
    // ValidationPipe that turns malformed query params into a stable 400
    // (NFR-3) instead of an unhandled 500.
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
  });

  it('/api/v1/products (GET) with no params returns a paginated page of the seeded Products (FR-6)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200)
      .expect((res) => {
        const body = res.body as PaginatedProducts;
        if (!Array.isArray(body.data) || body.data.length === 0) {
          throw new Error(
            `Expected a non-empty page, got: ${JSON.stringify(body)}`,
          );
        }
        if (
          body.meta.page !== 1 ||
          body.meta.limit !== 20 ||
          body.meta.total < 10
        ) {
          throw new Error(
            `Unexpected pagination meta: ${JSON.stringify(body.meta)}`,
          );
        }
        for (const item of body.data) {
          const hasCoreFields =
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.price === 'number' &&
            typeof item.inStock === 'boolean' &&
            typeof item.franchise === 'string' &&
            typeof item.rarity === 'string' &&
            typeof item.productType === 'string' &&
            'primaryImage' in item;
          if (!hasCoreFields) {
            throw new Error(
              `Product item missing required fields: ${JSON.stringify(item)}`,
            );
          }
        }
      });
  });

  it('/api/v1/products?limit=3 (GET) respects a custom page size', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?limit=3')
      .expect(200)
      .expect((res) => {
        const body = res.body as PaginatedProducts;
        if (body.data.length !== 3 || body.meta.limit !== 3) {
          throw new Error(
            `Expected exactly 3 items, got: ${JSON.stringify(body.meta)}`,
          );
        }
      });
  });

  it('/api/v1/products?search=Charizard (GET) finds the seeded "Charizard VMAX" via the pg_trgm-backed search (FR-6)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?search=Charizard')
      .expect(200)
      .expect((res) => {
        const body = res.body as PaginatedProducts;
        if (body.data.length === 0) {
          throw new Error('Expected at least one match for "Charizard"');
        }
        const names = body.data.map((item) => item.name);
        if (!names.includes('Charizard VMAX')) {
          throw new Error(
            `Expected the seeded "Charizard VMAX" Product among results, got: ${JSON.stringify(names)}`,
          );
        }
      });
  });

  it('/api/v1/products?franchise=POKEMON&productType=SINGLE_CARD (GET) combines filters with AND semantics', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?franchise=POKEMON&productType=SINGLE_CARD')
      .expect(200)
      .expect((res) => {
        const body = res.body as PaginatedProducts;
        if (body.data.length === 0) {
          throw new Error(
            'Expected at least one POKEMON SINGLE_CARD Product from the seed',
          );
        }
        for (const item of body.data) {
          if (
            item.franchise !== 'POKEMON' ||
            item.productType !== 'SINGLE_CARD'
          ) {
            throw new Error(
              `Expected every result to match both filters, got: ${JSON.stringify(item)}`,
            );
          }
        }
      });
  });

  it('/api/v1/products?franchise=POKEMON&rarity=SECRET_RARE (GET) returns a valid empty paginated page, never an error, when a filter combination matches nothing', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?franchise=POKEMON&rarity=SECRET_RARE')
      .expect(200)
      .expect((res) => {
        const body = res.body as PaginatedProducts;
        if (body.data.length !== 0 || body.meta.total !== 0) {
          throw new Error(
            `Expected an empty page, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('/api/v1/products?page=abc (GET) rejects a malformed page param with a stable 400 shape (NFR-3)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?page=abc')
      .expect(400)
      .expect((res) => {
        const body = res.body as {
          statusCode: number;
          error: string;
          message: unknown;
        };
        if (
          body.statusCode !== 400 ||
          body.error !== 'Bad Request' ||
          !body.message
        ) {
          throw new Error(
            `Expected a stable Bad Request shape, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('/api/v1/products?franchise=NOT_A_FRANCHISE (GET) rejects an out-of-enum franchise with a stable 400 shape (NFR-3)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?franchise=NOT_A_FRANCHISE')
      .expect(400)
      .expect((res) => {
        const body = res.body as { statusCode: number; error: string };
        if (body.statusCode !== 400 || body.error !== 'Bad Request') {
          throw new Error(
            `Expected a stable Bad Request shape, got: ${JSON.stringify(body)}`,
          );
        }
      });
  });

  it('/api/v1/products?limit=0 (GET) rejects an out-of-range limit with a stable 400 shape (NFR-3)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products?limit=0')
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
