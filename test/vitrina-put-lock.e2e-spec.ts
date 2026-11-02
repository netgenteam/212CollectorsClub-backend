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
import { PUT_LOCK_BUDGET_MS } from './../src/vitrina/admin-vitrina.service.js';
import {
  restoreVitrina,
  snapshotVitrina,
  type VitrinaSnapshot,
} from './helpers/vitrina-snapshot.js';

/**
 * Story 18.12 (QA D1): the PUT lock budget is enforced by the DATABASE
 * (`lock_timeout`), proven with a REAL external lock held on a separate `pg`
 * connection and the REAL configured 25 s budget.
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-putlock-${TAG}`;
const PASS = 'correct-horse-battery-staple-18-12';
const PUT = '/api/v1/admin/vitrina/algorithm';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DTO = {
  wSales: 30,
  wRevenue: 20,
  wVelocity: 20,
  wInterest: 20,
  wNovelty: 10,
};

describe('PUT /admin/vitrina/algorithm lock budget (Story 18.12)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let saved: VitrinaSnapshot;
  let locker: pg.Client | undefined;

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const put = () =>
    request(server())
      .put(PUT)
      .set({ Authorization: `Bearer ${token}` })
      .send(DTO);
  const audits = async () =>
    (
      await sql(
        `SELECT count(*)::int AS n FROM "Vitrina_Algorithm_Audits" WHERE "adminUserId" = $1`,
        [adminId],
      )
    )[0].n as number;
  const holdLock = async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.search = '';
    locker = new pg.Client({ connectionString: url.toString() });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(
      `SELECT 1 FROM "Vitrina_Algorithm_Settings" WHERE id = 'default' FOR UPDATE`,
    );
  };
  const release = async () => {
    if (!locker) return;
    await locker.query('ROLLBACK').catch(() => undefined);
    await locker.end().catch(() => undefined);
    locker = undefined;
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
    saved = await snapshotVitrina(sql);
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

  afterEach(async () => {
    await release();
  });

  afterAll(async () => {
    await release();
    await restoreVitrina(sql, saved);
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  }, 60_000);

  it('lock held indefinitely: 409 VITRINA_BUSY within the real 25 s budget, no audit, pool not stuck', async () => {
    expect(PUT_LOCK_BUDGET_MS).toBe(25_000);
    const auditsBefore = await audits();
    await holdLock();
    const t0 = Date.now();
    const res = await put();
    const elapsed = Date.now() - t0;
    console.log(`[18.12] indefinite lock: HTTP ${res.status} in ${elapsed} ms`);
    expect(res.status).toBe(409);
    expect((res.body as { errorCode: string }).errorCode).toBe('VITRINA_BUSY');
    expect(elapsed).toBeGreaterThanOrEqual(PUT_LOCK_BUDGET_MS - 500);
    expect(elapsed).toBeLessThanOrEqual(PUT_LOCK_BUDGET_MS + 1_500);
    expect(await audits()).toBe(auditsBefore);

    // The lock is still held and nothing is stuck behind it: lock-free GET.
    await request(server())
      .get(PUT)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    await release();
    const t1 = Date.now();
    await put().expect(200);
    expect(Date.now() - t1).toBeLessThan(5_000);
    expect(await audits()).toBe(auditsBefore + 1);
    // No transaction left idle/waiting by the app.
    const waiting = await sql(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    expect(waiting[0].n).toBe(0);
  }, 90_000);

  it('lock released after 3 s: the PUT waits and answers 200 with its audit', async () => {
    const auditsBefore = await audits();
    await holdLock();
    setTimeout(() => void release(), 3_000);
    const t0 = Date.now();
    const res = await put();
    const elapsed = Date.now() - t0;
    console.log(
      `[18.12] lock released at 3 s: HTTP ${res.status} in ${elapsed} ms`,
    );
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(PUT_LOCK_BUDGET_MS);
    expect(await audits()).toBe(auditsBefore + 1);
    await sleep(0);
  }, 60_000);
});
