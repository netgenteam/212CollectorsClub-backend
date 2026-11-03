import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FakeFxProvider } from './../src/fx/fake-fx.provider.js';
import { FX_PUT_BUDGET_MS } from './../src/fx/admin-fx.service.js';
import { restoreFx, snapshotFx, type FxState } from './helpers/db-snapshot.js';

/**
 * Story 19.4a (QA 19.4 observation): the TOTAL time of PUT /admin/fx/settings
 * is bounded, not just each lock wait. Worst case simulated with real locks:
 * lock 1 held 20 s, a provider read of 10.5 s (5 s timeout + retry + 5 s),
 * then lock 2 held "forever". Before the fix: 20 + 10.5 + 25 s (QA: 57-60.1 s,
 * Nginx cuts at 60 s). Time-dependent, so it lives in `pnpm test:perf`.
 * Elapsed times use the monotonic clock (the WSL2 wall clock steps back).
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-fxbudget-${TAG}`;
const PASS = 'correct-horse-battery-staple-19-4a';
const BASE = '/api/v1/admin/fx';
const READ_MS = 10_500;
const LOCK1_MS = 20_000;

describe('FX PUT total budget (perf, Story 19.4a)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fake: FakeFxProvider;
  let token: string;
  let adminId: string;
  let saved: FxState;
  let auditIdsBefore: string[];
  const lockers: pg.Client[] = [];

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const connect = async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.search = '';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    lockers.push(c);
    return c;
  };
  const lockAdvisory = async (c: pg.Client) => {
    await c.query('BEGIN');
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('fx:refresh', 0))`,
    );
  };
  const releaseAll = async () => {
    while (lockers.length) {
      const c = lockers.pop() as pg.Client;
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.set('trust proxy', 1);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.listen(0);
    prisma = app.get(PrismaService);
    fake = app.get(FakeFxProvider);
    saved = await snapshotFx(prisma);
    auditIdsBefore = (
      await prisma.fxSettingAudit.findMany({ select: { id: true } })
    ).map((a) => a.id);
    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: `${USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  }, 60_000);

  afterAll(async () => {
    await releaseAll();
    fake?.reset();
    await restoreFx(prisma, saved);
    await prisma.fxSettingAudit.deleteMany({
      where: { id: { notIn: auditIdsBefore } },
    });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  }, 60_000);

  it('NEEDS_READING path with a slow provider and two lock holds: 409 FX_SETTINGS_BUSY inside the total budget, nothing written', async () => {
    expect(FX_PUT_BUDGET_MS).toBeLessThanOrEqual(45_000);
    await prisma.$executeRaw`UPDATE "Fx_Rate_Settings" SET "source" = 'BCV_USD'::"FxRateSource" WHERE "id" = 'default'`;
    const audits = () => prisma.fxSettingAudit.count();
    const auditsBefore = await audits();
    fake.reset().slow(READ_MS);

    // Holder 1 keeps the FX lock for 20 s and, before releasing it, switches the
    // source to MANUAL: the PUT (BCV_USD) peeked BCV_USD, finds MANUAL under the lock.
    const h1 = await connect();
    await lockAdvisory(h1);
    await h1.query(
      `UPDATE "Fx_Rate_Settings" SET "source" = 'MANUAL'::"FxRateSource" WHERE "id" = 'default'`,
    );
    const t0 = performance.now();
    const pending = request(server())
      .put(`${BASE}/settings`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ source: 'BCV_USD' })
      .then((res) => ({ res, ms: performance.now() - t0 }));
    await new Promise((r) => setTimeout(r, LOCK1_MS));
    await h1.query('COMMIT');
    // Holder 2 takes the lock while the PUT is reading from the provider.
    await new Promise((r) => setTimeout(r, 3_000));
    const h2 = await connect();
    await lockAdvisory(h2);

    const { res, ms } = await pending;
    console.log(
      `[19.4a] FX PUT worst case: HTTP ${res.status} ${(res.body as { errorCode?: string }).errorCode} in ${ms} ms (lock1 ${LOCK1_MS} ms + read ${READ_MS} ms + lock2 held)`,
    );
    expect(res.status).toBe(409);
    expect((res.body as { errorCode?: string }).errorCode).toBe(
      'FX_SETTINGS_BUSY',
    );
    expect(ms).toBeLessThanOrEqual(FX_PUT_BUDGET_MS + 3_000);
    expect(ms).toBeLessThan(50_000); // Nginx cuts at 60 s: keep >= 10 s of margin
    await releaseAll();
    expect(await audits()).toBe(auditsBefore);
  }, 120_000);
});
