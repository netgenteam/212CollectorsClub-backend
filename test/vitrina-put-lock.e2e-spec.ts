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
// QA 20.5 (measured 26 513 ms against a 26 500 ms bound): the same WSL2 clock behaviour that
// `fx-lock-budget` documents in detail. The wall clock (`Date.now()`, which is also the one Postgres
// uses for `lock_timeout`) steps about 1.2 s FORWARD every ~32 s relative to the monotonic clock
// (`performance.now()`), so a wait timed with `Date.now()` can read 1.2 s too long (ceiling failure)
// and the database can spend its 25 s budget in 23.8 s of monotonic time (floor failure). Same rule
// as `fx-lock-budget`: the CEILING is judged on the monotonic clock (the time the caller really
// waited, budget + 3 s, still far below Nginx's 60 s) and the FLOOR on whichever clock has run
// more (the budget is spent when EITHER says so; a real defect would miss it by seconds, not by one
// 1.2 s step, which the 500 ms margin still catches).
const spentMs = (mono0: number, wall0: number): number =>
  Math.max(performance.now() - mono0, Date.now() - wall0);
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
    const t0 = performance.now();
    const w0 = Date.now();
    const res = await put();
    const elapsed = performance.now() - t0;
    const spent = spentMs(t0, w0);
    console.log(
      `[18.12] indefinite lock: HTTP ${res.status} in ${elapsed.toFixed(0)} ms (wall ${Date.now() - w0} ms)`,
    );
    expect(res.status).toBe(409);
    expect((res.body as { errorCode: string }).errorCode).toBe('VITRINA_BUSY');
    expect(spent).toBeGreaterThanOrEqual(PUT_LOCK_BUDGET_MS - 500);
    expect(elapsed).toBeLessThanOrEqual(PUT_LOCK_BUDGET_MS + 3_000);
    expect(await audits()).toBe(auditsBefore);

    // The lock is still held and nothing is stuck behind it: lock-free GET.
    await request(server())
      .get(PUT)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    await release();
    const t1 = performance.now();
    await put().expect(200);
    expect(performance.now() - t1).toBeLessThan(5_000);
    expect(await audits()).toBe(auditsBefore + 1);
    // No transaction left idle/waiting by the app.
    const waiting = await sql(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    expect(waiting[0].n).toBe(0);
  }, 90_000);

  it('two concurrent PUTs behind the same lock BOTH answer 409 within the budget (waiters do not compound)', async () => {
    const auditsBefore = await audits();
    await holdLock();
    const t0 = performance.now();
    const w0 = Date.now();
    const timed = async (r: request.Test) => {
      const res = await r;
      return {
        status: res.status,
        ms: performance.now() - t0,
        spent: spentMs(t0, w0),
      };
    };
    const [a, b] = await Promise.all([timed(put()), timed(put())]);
    console.log(
      `[19.1] vitrina 2 concurrent PUTs: ${a.status}/${a.ms.toFixed(0)} ms, ${b.status}/${b.ms.toFixed(0)} ms`,
    );
    expect([a.status, b.status]).toEqual([409, 409]);
    for (const r of [a, b]) {
      expect(r.spent).toBeGreaterThanOrEqual(PUT_LOCK_BUDGET_MS - 500);
      expect(r.ms).toBeLessThanOrEqual(PUT_LOCK_BUDGET_MS + 3_000);
    }
    expect(await audits()).toBe(auditsBefore);
  }, 90_000);

  it('lock released after 3 s: the PUT waits and answers 200 with its audit', async () => {
    const auditsBefore = await audits();
    await holdLock();
    setTimeout(() => void release(), 3_000);
    const t0 = performance.now();
    const res = await put();
    const elapsed = performance.now() - t0;
    console.log(
      `[18.12] lock released at 3 s: HTTP ${res.status} in ${elapsed.toFixed(0)} ms`,
    );
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(PUT_LOCK_BUDGET_MS);
    expect(await audits()).toBe(auditsBefore + 1);
    await sleep(0);
  }, 60_000);
});
