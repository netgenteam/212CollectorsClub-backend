import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { TCG_API_CLIENT } from './../src/tcg/tcg-api-client.interface.js';
import { FakeTcgApiClient } from './../src/tcg/fake-tcg-api-client.js';
import {
  TCG_ALLOW_FAKE_REMOTE_INGEST,
  TCG_REMOTE_INGEST_MAX_CARDS,
} from './../src/admin-tcg/admin-tcg.service.js';

type App = Parameters<typeof request>[0];
type Run = {
  id: string;
  kind: string;
  status: string;
  requestsUsed: number;
  quotaRemaining: number | null;
  summary: { created: number } | null;
  errorSummary: string | null;
};

const GAME = 'e2e159';
const ADMIN_USER = 'e2e159-admin';
const ADMIN_PASSWORD = 'E2e159-Pass-123!';
const BASE = '/api/v1/admin/tcg-master-cards';
const UUID0 = '00000000-0000-4000-8000-000000000000';

/**
 * Story 15.9 (AD-55/AD-56/AD-58): remote ingestion endpoints. Uses the
 * in-memory fake (no network). The fake is only accepted because this spec
 * sets the TEST-ONLY env `TCG_ALLOW_FAKE_REMOTE_INGEST`; the 503 test proves
 * the default refuses it.
 */
describe('Admin remote ingest (e2e, Story 15.9)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  const server = () => app.getHttpServer();
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const post = (body: object = {}) =>
    auth(request(server()).post(`${BASE}/ingest`)).send(body);
  const getRun = (id: string) =>
    auth(request(server()).get(`${BASE}/runs/${id}`));

  async function waitDone(id: string): Promise<Run> {
    for (let i = 0; i < 100; i++) {
      const res = await getRun(id).expect(200);
      const run = res.body as Run;
      if (run.status !== 'RUNNING') return run;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('run did not finish');
  }

  const clean = async () => {
    await prisma.masterCard.deleteMany({ where: { gameSlug: GAME } });
    await prisma.tcgIngestCursor.deleteMany({ where: { gameSlug: GAME } });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TCG_API_CLIENT)
      .useFactory({ factory: () => new FakeTcgApiClient() })
      .compile();
    app = moduleFixture.createNestApplication();
    const config = app.get(ConfigService);
    app.use(cookieParser(config.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.adminUser.create({
      data: {
        username: ADMIN_USER,
        email: `${ADMIN_USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    await clean();
  });

  afterEach(async () => {
    delete process.env[TCG_ALLOW_FAKE_REMOTE_INGEST];
    delete process.env[TCG_REMOTE_INGEST_MAX_CARDS];
    await prisma.tcgSyncRun.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    await clean();
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: ADMIN_USER } });
    await app.close();
  });

  it('401 without a token or with a garbage token, on all three endpoints', async () => {
    const bad = 'Bearer not-a-jwt';
    await request(server()).post(`${BASE}/ingest`).send({}).expect(401);
    await request(server()).get(`${BASE}/stats`).expect(401);
    await request(server()).get(`${BASE}/runs/${UUID0}`).expect(401);
    await request(server())
      .post(`${BASE}/ingest`)
      .set('Authorization', bad)
      .send({})
      .expect(401);
  });

  it('503 TCG_API_NOT_CONFIGURED with the fake client (default) and no row', async () => {
    const before = await prisma.tcgSyncRun.count();
    const res = await post({ games: [GAME] }).expect(503);
    expect(res.body).toMatchObject({ errorCode: 'TCG_API_NOT_CONFIGURED' });
    expect(await prisma.tcgSyncRun.count()).toBe(before);
  });

  it('202 {runId, RUNNING}; the run finishes in the background; stats reflect it', async () => {
    process.env[TCG_ALLOW_FAKE_REMOTE_INGEST] = 'true';
    process.env[TCG_REMOTE_INGEST_MAX_CARDS] = '1000';
    const res = await post({
      games: [GAME],
      setLimit: 1,
      maxRequests: 10,
    }).expect(202);
    const { runId, status } = res.body as { runId: string; status: string };
    expect(status).toBe('RUNNING');
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const done = await waitDone(runId);
    expect(done).toMatchObject({
      id: runId,
      kind: 'INGEST',
      status: 'SUCCEEDED',
    });
    expect(done.requestsUsed).toBeGreaterThan(0);
    expect(done.summary?.created).toBeGreaterThan(0);
    expect(await prisma.masterCard.count({ where: { gameSlug: GAME } })).toBe(
      done.summary!.created,
    );

    const stats = await auth(request(server()).get(`${BASE}/stats`)).expect(
      200,
    );
    const body = stats.body as {
      totalCards: number;
      byFranchise: Record<string, number>;
      lastRun: Run | null;
    };
    expect(body.totalCards).toBeGreaterThanOrEqual(done.summary!.created);
    expect(Object.values(body.byFranchise).reduce((a, b) => a + b, 0)).toBe(
      body.totalCards,
    );
    expect(body.lastRun?.id).toBe(runId);
  });

  describe('AC12: temporary per-run card cap', () => {
    const runOnce = async (body: object) => {
      const res = await post({ games: [GAME], setLimit: 1, ...body }).expect(
        202,
      );
      return waitDone((res.body as { runId: string }).runId);
    };
    const count = () => prisma.masterCard.count({ where: { gameSlug: GAME } });

    beforeEach(() => {
      process.env[TCG_ALLOW_FAKE_REMOTE_INGEST] = 'true';
    });
    afterEach(() => {
      delete process.env[TCG_REMOTE_INGEST_MAX_CARDS];
    });

    it('default cap 10: PARTIAL with cardCapReached, then the next run continues without duplicates or gaps', async () => {
      const first = await runOnce({});
      expect(first.status).toBe('PARTIAL');
      expect(first.summary).toMatchObject({
        created: 10,
        cardCapReached: true,
      });
      expect(await count()).toBe(10);

      const second = await runOnce({});
      expect(second.status).toBe('SUCCEEDED');
      expect(second.summary).toMatchObject({ created: 1 });
      expect(await count()).toBe(11); // 12 fake cards, 1 sealed skipped

      const third = await runOnce({});
      expect(third.summary).toMatchObject({ created: 0 });
      expect(await count()).toBe(11);
    });

    it('a body maxCards above the server cap is clamped, below it is honoured', async () => {
      process.env[TCG_REMOTE_INGEST_MAX_CARDS] = '4';
      const clamped = await runOnce({ maxCards: 1000 });
      expect(clamped.summary).toMatchObject({
        created: 4,
        cardCapReached: true,
      });
      const lower = await runOnce({ maxCards: 2 });
      expect(lower.summary).toMatchObject({ created: 2, cardCapReached: true });
      expect(await count()).toBe(6);
    });
  });

  it('409 TCG_SYNC_ALREADY_RUNNING with the active run id; no new row', async () => {
    process.env[TCG_ALLOW_FAKE_REMOTE_INGEST] = 'true';
    const active = await prisma.tcgSyncRun.create({
      data: { kind: 'NIGHTLY', status: 'RUNNING' },
    });
    const before = await prisma.tcgSyncRun.count();
    const res = await post({ games: [GAME] }).expect(409);
    expect(res.body).toMatchObject({
      errorCode: 'TCG_SYNC_ALREADY_RUNNING',
      details: { runId: active.id },
    });
    expect(await prisma.tcgSyncRun.count()).toBe(before);
  });

  it('400 on an invalid body (caps, types)', async () => {
    process.env[TCG_ALLOW_FAKE_REMOTE_INGEST] = 'true';
    for (const body of [
      { maxRequests: 0 },
      { maxCards: 0 },
      { maxRequests: 100000 },
      { setLimit: 0 },
      { games: 'pokemon' },
      { sets: [1] },
      { refreshSets: 'yes' },
    ]) {
      await post(body).expect(400);
    }
  });

  it('runs/:id: 404 unknown, 400 not a uuid', async () => {
    await getRun(UUID0).expect(404);
    await getRun('nope').expect(400);
  });
});
