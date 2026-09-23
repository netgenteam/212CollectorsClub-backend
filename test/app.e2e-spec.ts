import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
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
    await app.init();
  });

  it('/health (GET) returns 200 with an ok status when the DB is reachable', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        const body = res.body as HealthStatus;
        if (body.status !== 'ok' || body.database !== 'up') {
          throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`);
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
