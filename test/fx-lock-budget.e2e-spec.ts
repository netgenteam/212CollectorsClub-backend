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
import { FX_LOCK_BUDGET_MS } from './../src/fx/admin-fx.service.js';
import { restoreFx, snapshotFx, type FxState } from './helpers/db-snapshot.js';

/**
 * Story 19.1 (QA 18.12 observation, same cause as D1): PUT /admin/fx/settings
 * and POST /admin/fx/accept-rejected bound their lock waits IN THE DATABASE
 * (`lock_timeout`). Proven with REAL external locks held on a separate `pg`
 * connection and the REAL 25 s budget; the measured wait is logged.
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-fxlock-${TAG}`;
const PASS = 'correct-horse-battery-staple-19-1';
const BASE = '/api/v1/admin/fx';
const MANUAL = { source: 'MANUAL', manualVesPerUsd: 77.5 };

describe('FX admin lock budget (e2e, Story 19.1)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let saved: FxState;
  let auditIdsBefore: string[];
  let locker: pg.Client | undefined;

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const put = () =>
    request(server()).put(`${BASE}/settings`).set(auth()).send(MANUAL);
  const accept = () =>
    request(server()).post(`${BASE}/accept-rejected`).set(auth());
  const audits = async () =>
    (
      await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Fx_Setting_Audits" WHERE "adminUserId" = ${adminId}::uuid`
    )[0].n;
  const hold = async (kind: 'advisory' | 'row') => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.search = '';
    locker = new pg.Client({ connectionString: url.toString() });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(
      kind === 'advisory'
        ? `SELECT pg_advisory_xact_lock(hashtextextended('fx:refresh', 0))`
        : `SELECT 1 FROM "Fx_Rate_Settings" WHERE id = 'default' FOR UPDATE`,
    );
  };
  const release = async () => {
    if (!locker) return;
    await locker.query('ROLLBACK').catch(() => undefined);
    await locker.end().catch(() => undefined);
    locker = undefined;
  };
  const code = (res: request.Response) =>
    (res.body as { errorCode?: string }).errorCode;
  const setRejected = () =>
    prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "source" = 'BCV_USD'::"FxRateSource",
        "rejectedReading" = ${JSON.stringify({
          source: 'BCV_USD',
          rawRate: '120.0000',
          providerUpdatedAt: new Date().toISOString(),
          reason: 'VARIATION_EXCEEDED',
        })}::jsonb WHERE "id" = 'default'`;

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

  afterEach(release);

  afterAll(async () => {
    await release();
    await restoreFx(prisma, saved);
    await prisma.fxSettingAudit.deleteMany({
      where: { id: { notIn: auditIdsBefore } },
    });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  }, 60_000);

  it('FX advisory lock held indefinitely: PUT answers 409 FX_SETTINGS_BUSY within the real 25 s budget, writes nothing, and works after release', async () => {
    expect(FX_LOCK_BUDGET_MS).toBe(25_000);
    const before = await audits();
    const rowBefore = JSON.stringify(
      await prisma.$queryRaw`SELECT * FROM "Fx_Rate_Settings"`,
    );
    await hold('advisory');
    const t0 = Date.now();
    const res = await put();
    const elapsed = Date.now() - t0;
    console.log(
      `[19.1] FX PUT, advisory lock held: HTTP ${res.status} in ${elapsed} ms`,
    );
    expect(res.status).toBe(409);
    expect(code(res)).toBe('FX_SETTINGS_BUSY');
    expect(elapsed).toBeGreaterThanOrEqual(FX_LOCK_BUDGET_MS - 500);
    expect(elapsed).toBeLessThanOrEqual(FX_LOCK_BUDGET_MS + 1_500);
    expect(await audits()).toBe(before);
    expect(
      JSON.stringify(await prisma.$queryRaw`SELECT * FROM "Fx_Rate_Settings"`),
    ).toBe(rowBefore);
    // Reads are not stuck behind the lock.
    await request(server()).get(`${BASE}/status`).set(auth()).expect(200);
    await release();
    const t1 = Date.now();
    await put().expect(200);
    expect(Date.now() - t1).toBeLessThan(5_000);
    expect(await audits()).toBe(before + 1);
    const waiting = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(waiting[0].n).toBe(0);
  }, 90_000);

  it('settings row locked indefinitely: PUT and accept-rejected BOTH answer 409 FX_SETTINGS_BUSY within the real budget (no hang, no 500)', async () => {
    await setRejected();
    const before = await audits();
    await hold('row');
    const t0 = Date.now();
    const timed = async (r: request.Test) => {
      const res = await r;
      return { res, ms: Date.now() - t0 };
    };
    const [pt, at] = await Promise.all([timed(put()), timed(accept())]);
    const p = pt.res;
    const a = at.res;
    console.log(`[19.1] FX row lock: PUT ${pt.ms} ms, accept ${at.ms} ms`);
    const elapsed = Date.now() - t0;
    console.log(
      `[19.1] FX row lock held: PUT ${p.status}, accept-rejected ${a.status} in ${elapsed} ms`,
    );
    expect([p.status, a.status]).toEqual([409, 409]);
    expect([code(p), code(a)]).toEqual([
      'FX_SETTINGS_BUSY',
      'FX_SETTINGS_BUSY',
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(FX_LOCK_BUDGET_MS - 500);
    expect(elapsed).toBeLessThanOrEqual(FX_LOCK_BUDGET_MS + 1_500);
    expect(await audits()).toBe(before);
    await release();
    // The rejected reading is still there and now applies.
    await accept().expect(200);
    expect(await audits()).toBe(before + 1);
  }, 90_000);

  it('lock released after 3 s: both calls wait and answer 200 with their audit', async () => {
    await setRejected();
    const before = await audits();
    await hold('advisory');
    setTimeout(() => void release(), 3_000);
    const t0 = Date.now();
    const res = await put();
    const elapsed = Date.now() - t0;
    console.log(
      `[19.1] FX PUT, advisory released at 3 s: HTTP ${res.status} in ${elapsed} ms`,
    );
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(FX_LOCK_BUDGET_MS);
    expect(await audits()).toBe(before + 1);

    await setRejected();
    await hold('row');
    setTimeout(() => void release(), 3_000);
    const t1 = Date.now();
    const acc = await accept();
    console.log(
      `[19.1] FX accept-rejected, row released at 3 s: HTTP ${acc.status} in ${Date.now() - t1} ms`,
    );
    expect(acc.status).toBe(200);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(2_500);
    expect(await audits()).toBe(before + 2);
  }, 60_000);
});
