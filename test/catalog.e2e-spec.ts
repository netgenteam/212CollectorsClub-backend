import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';

type App = Parameters<typeof request>[0];

// Runs against the shared dev Postgres seeded by Story 1.4 (prisma/seed.ts),
// same as app.e2e-spec.ts. That DB always has the 4 seeded Categories, so it
// exercises the "Categories exist" AC for real; the "no Categories exist"
// AC is covered separately in catalog.service.spec.ts against a mocked
// PrismaService (see the comment there for why).
describe('CatalogController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirrors main.ts bootstrap (Story 1.2): global "/api" prefix + URI
    // versioning with default version "1".
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
  });

  it('/api/v1/categories (GET) returns 200 with the seeded Categories, each with id/name/slug (FR-5)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/categories')
      .expect(200)
      .expect((res) => {
        const body = res.body as Array<{
          id: string;
          name: string;
          slug: string;
        }>;
        if (!Array.isArray(body) || body.length === 0) {
          throw new Error(
            `Expected a non-empty array of seeded Categories, got: ${JSON.stringify(body)}`,
          );
        }
        for (const category of body) {
          if (!category.id || !category.name || !category.slug) {
            throw new Error(
              `Expected every Category to have id/name/slug, got: ${JSON.stringify(category)}`,
            );
          }
        }
        const slugs = body.map((category) => category.slug).sort();
        const expectedSlugs = [
          'cartas-sueltas',
          'ediciones-especiales',
          'mazos-preconstruidos',
          'sobres-y-cajas',
        ];
        for (const expectedSlug of expectedSlugs) {
          if (!slugs.includes(expectedSlug)) {
            throw new Error(
              `Expected seeded Category slug "${expectedSlug}" to be present, got slugs: ${JSON.stringify(slugs)}`,
            );
          }
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
