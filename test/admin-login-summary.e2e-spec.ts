import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AdminLoginFailureSummary } from './../src/admin-auth/admin-login-failure-summary.js';
import { mintAdminToken } from './helpers/admin-session.js';

/**
 * Story 20.5 follow-up: `LOGIN_ADMIN_FAILED` events the per-minute budget discards are not lost:
 * ONE `LOGIN_ADMIN_FAILED_SUMMARY` per window carries their count and (hashed) identifiers, it is
 * durable in the chain, the admin reads it through `GET /admin/audit/events`, and what is still
 * pending is flushed when the app closes. Runs on the disposable database of the run.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const BASE = '/api/v1';
const ADMIN_USER = `e2e-sum-${TAG}`;

const ENV_KEYS = [
  'AUDIT_LOGIN_FAILED_MAX_PER_MINUTE',
  'AUDIT_LOGIN_SUMMARY_WINDOW_MS',
  'ADMIN_LOGIN_MAX_FAILURES_PER_IP',
  'ADMIN_LOGIN_MAX_FAILURES_PER_USER',
] as const;

describe(
  'LOGIN_ADMIN_FAILED_SUMMARY (e2e, Story 20.5 follow-up)',
  { timeout: 120_000 },
  () => {
    const saved: Record<string, string | undefined> = {};
    let app: NestExpressApplication;
    let prisma: PrismaService;
    let adminId: string;
    let token: string;
    const sql = (q: string, p: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
    const head = async () =>
      Number(
        (
          await sql(
            `SELECT COALESCE(max("seq"),0)::int AS s FROM "Audit_Events"`,
          )
        )[0].s,
      );
    const waitFor = async <T>(
      fn: () => Promise<T | null | false>,
      ms = 10_000,
    ): Promise<T> => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    async function boot(): Promise<NestExpressApplication> {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true })
        .compile();
      const a = moduleFixture.createNestApplication<NestExpressApplication>({
        rawBody: true,
      });
      a.set('trust proxy', 1);
      applyRequestContext(a);
      a.use(
        cookieParser(a.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
      );
      a.setGlobalPrefix('api');
      a.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      a.useGlobalPipes(createGlobalValidationPipe());
      await a.init();
      return a;
    }
    const failLogin = (a: NestExpressApplication, ip: string, user: string) =>
      request(a.getHttpServer() as Parameters<typeof request>[0])
        .post(`${BASE}/admin/auth/login`)
        .set('X-Forwarded-For', ip)
        .send({ usernameOrEmail: user, password: 'nope-nope-nope' });

    beforeAll(async () => {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      // The budget under test: 6 written per minute (the rest is discarded). The window is long
      // (the tests flush by hand); the timer test uses its own app with a short one.
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '6';
      process.env.AUDIT_LOGIN_SUMMARY_WINDOW_MS = '3600000';
      process.env.ADMIN_LOGIN_MAX_FAILURES_PER_IP = '100000';
      process.env.ADMIN_LOGIN_MAX_FAILURES_PER_USER = '100000';
      app = await boot();
      prisma = app.get(PrismaService);
      const passwordHash = await argon2.hash(
        'correct-horse-battery-staple-20-5',
        {
          type: argon2.argon2id,
        },
      );
      adminId = (
        await prisma.adminUser.create({
          data: {
            username: ADMIN_USER,
            email: `${ADMIN_USER}@212collectorsclub.test`,
            passwordHash,
          },
        })
      ).id;
      token = await mintAdminToken(app, adminId);
    });

    afterAll(async () => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await prisma?.adminUser
        .delete({ where: { id: adminId } })
        .catch(() => undefined);
      await app?.close();
    });

    it('40 failures leave the budgeted events (6) plus ONE summary counting the 34 discarded, hashed, and the admin can read it', async () => {
      const since = await head();
      const typed = `Victim.${TAG}@Example.com`;
      for (let i = 0; i < 40; i++) {
        // 40 different IPs: neither failure limit gets in the way, only the event budget does
        const r = await failLogin(
          app,
          `198.51.100.${(i % 250) + 1}`,
          i % 2 ? typed : `ghost-${TAG}-${i}`,
        );
        expect(r.status).toBe(401);
      }
      // the 6 budgeted writes are fire-and-forget: wait for them, then close the window by hand
      const written = await waitFor(async () => {
        const r = await sql(
          `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED' AND "seq" > $1`,
          [since],
        );
        return Number(r[0].n) >= 6 ? Number(r[0].n) : null;
      });
      expect(written).toBe(6);
      const summary = app.get(AdminLoginFailureSummary);
      expect(summary.pending).toBe(34);
      await summary.flush();
      expect(summary.pending).toBe(0);

      // the budget did not move: still exactly 6 LOGIN_ADMIN_FAILED
      const failed = await sql(
        `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED' AND "seq" > $1`,
        [since],
      );
      expect(Number(failed[0].n)).toBe(6);

      // durable, in the chain, readable by the admin through the audit API
      const res = await request(
        app.getHttpServer() as Parameters<typeof request>[0],
      )
        .get(
          `${BASE}/admin/audit/events?action=LOGIN_ADMIN_FAILED_SUMMARY&limit=50`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const items = (
        res.body as {
          items: {
            action: string;
            seq: number;
            actorType: string;
            after: Record<string, unknown>;
          }[];
        }
      ).items.filter((i) => i.seq > since);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        action: 'LOGIN_ADMIN_FAILED_SUMMARY',
        actorType: 'SYSTEM',
        after: {
          dropped: 34,
          distinctIdentifiers: 18, // 17 distinct ghosts among the discarded + the one typed value
          identifiersTruncated: false,
          distinctIps: 34,
        },
      });
      const after = items[0].after as {
        windowSeconds: number;
        identifierHashes: string[];
        windowStart: string;
        windowEnd: string;
      };
      expect(after.windowSeconds).toBeGreaterThanOrEqual(1);
      expect(Date.parse(after.windowEnd)).toBeGreaterThanOrEqual(
        Date.parse(after.windowStart),
      );
      expect(after.identifierHashes).toHaveLength(18);
      expect(
        after.identifierHashes.every((h) => /^[0-9a-f]{64}$/.test(h)),
      ).toBe(true);
      // never the typed values, never an address
      const raw = JSON.stringify(items[0]);
      expect(raw.toLowerCase()).not.toContain('victim');
      expect(raw).not.toContain('example.com');
      expect(raw).not.toMatch(/198\.51\.100/);
    });

    it('a second flush with nothing new writes nothing (one summary per window)', async () => {
      const since = await head();
      await app.get(AdminLoginFailureSummary).flush();
      await app.get(AdminLoginFailureSummary).flush();
      expect(await head()).toBe(since);
    });

    it('the window timer writes the summary by itself (short window), once', async () => {
      process.env.AUDIT_LOGIN_SUMMARY_WINDOW_MS = '400';
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1';
      const a2 = await boot();
      try {
        const since = await head();
        for (let i = 0; i < 4; i++) {
          await failLogin(a2, `203.0.113.${i + 1}`, `timer-${TAG}-${i}`).expect(
            401,
          );
        }
        const rows = await waitFor(async () => {
          const r = await sql(
            `SELECT "after" FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED_SUMMARY' AND "seq" > $1`,
            [since],
          );
          return r.length >= 1 ? r : null;
        });
        expect(rows).toHaveLength(1);
        expect((rows[0].after as { dropped: number }).dropped).toBe(3);
        await new Promise((r) => setTimeout(r, 1_000));
        const again = await sql(
          `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED_SUMMARY' AND "seq" > $1`,
          [since],
        );
        expect(Number(again[0].n)).toBe(1);
      } finally {
        await a2.close();
        process.env.AUDIT_LOGIN_SUMMARY_WINDOW_MS = '3600000';
        process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '6';
      }
    });

    it('closing the app flushes what is pending into the chain', async () => {
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1';
      const a3 = await boot();
      const since = await head();
      for (let i = 0; i < 3; i++) {
        await failLogin(
          a3,
          `203.0.113.${100 + i}`,
          `closing-${TAG}-${i}`,
        ).expect(401);
      }
      expect(a3.get(AdminLoginFailureSummary).pending).toBe(2);
      expect(
        Number(
          (
            await sql(
              `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED_SUMMARY' AND "seq" > $1`,
              [since],
            )
          )[0].n,
        ),
      ).toBe(0);
      await a3.close(); // onModuleDestroy runs before Prisma disconnects: the event is written
      const rows = await sql(
        `SELECT "after" FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED_SUMMARY' AND "seq" > $1`,
        [since],
      );
      expect(rows).toHaveLength(1);
      expect((rows[0].after as { dropped: number }).dropped).toBe(2);
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '6';
    });
  },
);
