import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { HealthStatus } from './../src/app.service.js';

// `supertest/types` doesn't resolve under TS's `nodenext` module resolution
// (the `@types/supertest` package has no `exports` map for that subpath), so
// the app-server type is derived from `request`'s own signature instead.
type App = Parameters<typeof request>[0];

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirrors main.ts bootstrap (Story 1.2): global "/api" prefix + URI
    // versioning with default version "1", so every route in the app is
    // only reachable under /api/v1 — plus the Swagger doc mounted at
    // /api/docs, generated purely from controller/DTO decorators.
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    const swaggerConfig = new DocumentBuilder()
      .setTitle('212CollectorsClub API')
      .setVersion('1.0')
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);

    await app.init();
  });

  it('/api/v1/health (GET) returns 200 with an ok status when the DB is reachable', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((res) => {
        const body = res.body as HealthStatus;
        if (body.status !== 'ok' || body.database !== 'up') {
          throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`);
        }
      });
  });

  it('/health (GET) — the unversioned, unprefixed route — is not reachable (FR-1)', () => {
    return request(app.getHttpServer()).get('/health').expect(404);
  });

  it('/v1/health (GET) — versioned but missing the /api prefix — is not reachable (FR-1)', () => {
    return request(app.getHttpServer()).get('/v1/health').expect(404);
  });

  it('/api/health (GET) — prefixed but missing the version — is not reachable (FR-1)', () => {
    return request(app.getHttpServer()).get('/api/health').expect(404);
  });

  it('/api/docs (GET) serves the live Swagger UI (FR-2)', () => {
    return request(app.getHttpServer())
      .get('/api/docs')
      .expect(200)
      .expect((res) => {
        if (!res.text.includes('swagger-ui')) {
          throw new Error('Expected the Swagger UI HTML page');
        }
      });
  });

  it('/api/docs-json (GET) serves the generated OpenAPI document listing /api/v1/health (FR-2)', () => {
    return request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200)
      .expect((res) => {
        const body = res.body as { paths?: Record<string, unknown> };
        if (!body.paths || !('/api/v1/health' in body.paths)) {
          throw new Error(
            `Expected OpenAPI doc to list /api/v1/health, got paths: ${JSON.stringify(
              body.paths && Object.keys(body.paths),
            )}`,
          );
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
