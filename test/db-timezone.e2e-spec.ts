/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies and raw rows are untyped JSON */
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaClient } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { readDatabaseClockCheck } from './../src/prisma/db-clock-check.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import {
  GENESIS_HASH,
  computeAuditHash,
} from './../src/audit/canonical-json.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';
import { assertThrowawayUrl, dbNameOf } from './helpers/test-db.js';

/**
 * Story 20.8 round 2: the application works the same whatever time zone the DATABASE is configured with.
 *
 * The Prisma driver adapter misreads every `timestamptz` of a session whose zone is not UTC (measured: `SELECT now()`
 * came back 18 000 s off under America/New_York, so every retention run aborted with CLOCK_SKEW). The application now
 * opens every connection with `options=-c TimeZone=UTC` (src/prisma/db-session.ts). This file sets the throw-away
 * clone's own `TimeZone` to each zone (`ALTER DATABASE ... SET timezone`, only ever on an e2e clone) and boots the whole
 * application against it: the server answers, the audit chain verifies (also with an independent raw `pg` reader that
 * does not go through the adapter), the hash of an event does not depend on the zone, a retention run is OK, and the
 * calendar-month arithmetic of the contact messages gives the same cut-off.
 *
 * Run the WHOLE suite under each zone with `ALTER DATABASE <source> SET timezone` / `ALTER ROLE ... SET timezone`
 * (docs/deployment.md 21.4).
 */
const BASE = '/api/v1';
const ZONES = [
  'UTC',
  'America/Caracas',
  'America/New_York',
  'Asia/Tokyo',
] as const;
const MARK = `e2e-tz-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
/** The hash of the fixed vector above, computed once with the database (and Node's TZ) in UTC and again in Asia/Tokyo. */
const GOLDEN_HASH =
  '6715a5fd7f5848853d6bac67f41978db6b996b6384d57daf4afadf10c9eab76e';
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function bootApp(): Promise<{
  app: NestExpressApplication;
  base: string;
}> {
  const saved = {
    RETENTION_PURGE_ENABLED: process.env.RETENTION_PURGE_ENABLED,
    RETENTION_BATCH_PAUSE_MS: process.env.RETENTION_BATCH_PAUSE_MS,
  };
  process.env.RETENTION_PURGE_ENABLED = 'true';
  process.env.RETENTION_BATCH_PAUSE_MS = '0';
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.set('trust proxy', 1);
    applyRequestContext(app);
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as { port: number }).port;
    return { app, base: `http://127.0.0.1:${port}` };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe(
  'Database time zone (e2e, Story 20.8 round 2)',
  { timeout: 180_000 },
  () => {
    const dbName = dbNameOf(process.env.DATABASE_URL as string);
    let owner: pg.Client;

    beforeAll(async () => {
      // Only ever a throw-away clone: ALTER DATABASE ... SET is applied to nothing else.
      assertThrowawayUrl(process.env.DATABASE_URL, 'DATABASE_URL');
      owner = new pg.Client({ connectionString: adminDatabaseUrl() });
      await owner.connect();
    });

    afterAll(async () => {
      await owner.query(`ALTER DATABASE ${q(dbName)} RESET timezone`);
      await owner.end();
    });

    describe.each(ZONES)('database TimeZone = %s', (zone) => {
      let app: NestExpressApplication;
      let base: string;
      let prisma: PrismaService;
      let token: string;
      let adminId: string;
      let raw: pg.Client; // a plain `pg` client with NO session options: sees the database's own zone, reads instants right

      beforeAll(async () => {
        await owner.query(
          `ALTER DATABASE ${q(dbName)} SET timezone = '${zone}'`,
        );
        ({ app, base } = await bootApp());
        prisma = app.get(PrismaService);
        raw = new pg.Client({ connectionString: adminDatabaseUrl() });
        await raw.connect();
        const a = await prisma.adminUser.create({
          data: {
            username: `${MARK}-${zone.replace(/\W/g, '')}`,
            email: `${MARK}-${zone.replace(/\W/g, '').toLowerCase()}@212collectorsclub.test`,
            passwordHash: 'x',
          },
        });
        adminId = a.id;
        token = await mintAdminToken(app, adminId);
      });

      afterAll(async () => {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "Retention_Runs" WHERE "triggeredById" = $1::uuid`,
          adminId,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "Contact_Inquiries" WHERE "name" LIKE $1`,
          `${MARK}%`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "Usage_Logs" WHERE "route" LIKE $1`,
          `/${MARK}%`,
        );
        await prisma.adminUser
          .delete({ where: { id: adminId } })
          .catch(() => undefined);
        await raw.end();
        await app.close();
      });

      const auth = () => ({ Authorization: `Bearer ${token}` });
      const server = () => request.agent(base);

      it('the database really is in that zone for a plain connection, and the application connection runs in UTC anyway', async () => {
        const shown = await raw.query<{ z: string }>(
          `SELECT current_setting('TimeZone') AS z`,
        );
        expect(shown.rows[0].z).toBe(zone);
        const appZone = await prisma.$queryRaw<
          { z: string }[]
        >`SELECT current_setting('TimeZone') AS z`;
        expect(appZone[0].z).toBe('UTC');
      });

      it('CONTROL: an adapter WITHOUT the session option misreads now() by exactly the zone offset (the defect)', async () => {
        const naive = new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL as string,
          }),
        });
        try {
          const r = await naive.$queryRaw<
            { n: Date; e: bigint; off: number }[]
          >`SELECT now() AS n, (floor(extract(epoch FROM now()) * 1000))::bigint AS e,
                 extract(timezone FROM now())::float8 AS off`;
          const errMs = r[0].n.getTime() - Number(r[0].e);
          // the text '... 01:00:03.784-05' is read as if it were UTC: the error is the offset itself
          expect(Math.round(errMs / 1000)).toBe(Math.round(r[0].off));
          if (zone === 'UTC') expect(errMs).toBe(0);
          else expect(errMs).not.toBe(0);
        } finally {
          await naive.$disconnect();
        }
      });

      it('the clock check of the boot reads instants correctly', async () => {
        const c = await readDatabaseClockCheck(prisma);
        expect(c.ok).toBe(true);
        expect(Math.abs(c.parseErrorMs)).toBeLessThanOrEqual(1);
        expect(c.sessionZone).toBe('UTC');
      });

      it('the server answers the same: health, public catalog, FX, and an authenticated admin route', async () => {
        await server().get(`${BASE}/health`).expect(200);
        await server().get(`${BASE}/fx/current`).expect(200);
        await server().get(`${BASE}/products`).expect(200);
        await server()
          .get(`${BASE}/admin/retention/config`)
          .set(auth())
          .expect(200);
      });

      it('a timestamptz written through Prisma comes back as the same instant through Prisma and through a plain pg client (also across a DST gap)', async () => {
        const at = new Date('2026-03-08T07:30:00.123Z'); // 02:30 on the day New York skips an hour
        const finished = new Date('2026-11-01T05:59:59.999Z'); // the hour New York repeats
        const run = await prisma.retentionRun.create({
          data: {
            trigger: 'MANUAL',
            triggeredById: adminId,
            status: 'OK',
            startedAt: at,
            finishedAt: finished,
          },
        });
        const viaPrisma = await prisma.retentionRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(viaPrisma.startedAt.toISOString()).toBe(at.toISOString());
        expect(viaPrisma.finishedAt?.toISOString()).toBe(
          finished.toISOString(),
        );
        const viaRaw = await raw.query<{ s: Date; f: Date }>(
          `SELECT "startedAt" AS s, "finishedAt" AS f FROM "Retention_Runs" WHERE "id" = $1::uuid`,
          [run.id],
        );
        expect(viaRaw.rows[0].s.toISOString()).toBe(at.toISOString());
        expect(viaRaw.rows[0].f.toISOString()).toBe(finished.toISOString());
        // and a raw read through the adapter (queryRaw) agrees too
        const viaQueryRaw = await prisma.$queryRaw<
          { s: Date }[]
        >`SELECT "startedAt" AS s FROM "Retention_Runs" WHERE "id" = ${run.id}::uuid`;
        expect(viaQueryRaw[0].s.toISOString()).toBe(at.toISOString());
      });

      it('the hash of an audit event does NOT change with the zone: the same stored instant gives the same hash', async () => {
        const content = (occurredAt: Date) => ({
          seq: 7,
          occurredAt,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'RETENTION_PURGE_RUN',
          entityType: 'RetentionRun',
          entityId: 'e2e',
          before: null,
          after: { n: 1 },
          reason: null,
          requestId: null,
          ip: null,
        });
        const expected = computeAuditHash(
          GENESIS_HASH,
          content(new Date('2026-03-08T07:30:00.123Z')),
        );
        const r = await prisma.$queryRaw<
          { t: Date }[]
        >`SELECT '2026-03-08 07:30:00.123+00'::timestamptz AS t`;
        expect(computeAuditHash(GENESIS_HASH, content(r[0].t))).toBe(expected);
        // a fixed vector, the same in every zone (computed once under UTC)
        expect(expected).toMatch(/^[0-9a-f]{64}$/);
        expect(expected).toBe(GOLDEN_HASH);
      });

      it('the audit chain verifies: through the application, through an independent plain pg reader, and the new events carry the real instant', async () => {
        const t0 = Date.now();
        // an audited action written in this zone
        const v1 = await server()
          .post(`${BASE}/admin/audit/verify`)
          .set(auth())
          .send({ mode: 'full' })
          .expect(200);
        expect(v1.body).toMatchObject({ ok: true, done: true });
        const v2 = await server()
          .post(`${BASE}/admin/audit/verify`)
          .set(auth())
          .send({ mode: 'full' })
          .expect(200);
        expect(v2.body).toMatchObject({ ok: true, done: true });
        expect(v2.body.rows).toBeGreaterThan(v1.body.rows as number);

        const viaRaw = await new AuditChainVerifier().verify(
          async (sql, params = []) =>
            (await raw.query<Record<string, unknown>>(sql, params)).rows,
          { mode: 'full' },
        );
        expect(viaRaw).toMatchObject({ ok: true, done: true });
        // the second verification wrote its own AUDIT_VERIFIED event after counting
        expect(viaRaw.rows).toBe((v2.body.rows as number) + 1);

        // the stored instant of the newest event is the real one (read by the plain client): not shifted by the zone
        const head = await raw.query<{ occurredAt: Date; action: string }>(
          `SELECT "occurredAt", "action" FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1`,
        );
        expect(
          Math.abs(head.rows[0].occurredAt.getTime() - Date.now()),
        ).toBeLessThan(Date.now() - t0 + 60_000);
      });

      it('a retention run is OK (no CLOCK_SKEW) and purges: the usage log of 8 days and the contact message of 12 months + 2 days go, those inside their period stay', async () => {
        const logOld = randomUUID();
        const logNew = randomUUID();
        for (const [id, days] of [
          [logOld, 8],
          [logNew, 6],
        ] as const) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","requestId")
           VALUES (now() - make_interval(days => $2::int), 'GET', $3, 200, 1, 'ANON', $1::uuid)`,
            id,
            days,
            `/${MARK}-${zone}`,
          );
        }
        const cOld = randomUUID();
        const cNew = randomUUID();
        for (const [id, ago] of [
          [cOld, '12 months 2 days'],
          [cNew, '11 months 27 days'],
        ] as const) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
           VALUES ($1::uuid, $2, 'tz@212collectorsclub.test', 'x',
                   ((now() AT TIME ZONE 'UTC') - interval '${ago}'), ((now() AT TIME ZONE 'UTC') - interval '${ago}'))`,
            id,
            `${MARK}-${zone}-contact`,
          );
        }
        const res = await server()
          .post(`${BASE}/admin/retention/run`)
          .set(auth())
          .send({})
          .expect(202);
        const runId = res.body.runId as string;
        let run: { status: string; errorSummary: string | null } | undefined;
        for (let i = 0; i < 300; i++) {
          const r = await raw.query<{
            status: string;
            errorSummary: string | null;
          }>(
            `SELECT "status", "errorSummary" FROM "Retention_Runs" WHERE "id" = $1::uuid`,
            [runId],
          );
          if (r.rows[0] && r.rows[0].status !== 'RUNNING') {
            run = r.rows[0];
            break;
          }
          await new Promise((r2) => setTimeout(r2, 100));
        }
        expect(run).toEqual({ status: 'OK', errorSummary: null });
        const n = async (table: string, col: string, id: string) =>
          Number(
            (
              await raw.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM "${table}" WHERE "${col}" = $1::uuid`,
                [id],
              )
            ).rows[0].n,
          );
        expect(await n('Usage_Logs', 'requestId', logOld)).toBe(0);
        expect(await n('Usage_Logs', 'requestId', logNew)).toBe(1);
        expect(await n('Contact_Inquiries', 'id', cOld)).toBe(0);
        expect(await n('Contact_Inquiries', 'id', cNew)).toBe(1);
        // the run row is stamped with the real instant
        const stamp = await raw.query<{ startedAt: Date }>(
          `SELECT "startedAt" FROM "Retention_Runs" WHERE "id" = $1::uuid`,
          [runId],
        );
        expect(
          Math.abs(stamp.rows[0].startedAt.getTime() - Date.now()),
        ).toBeLessThan(120_000);
      });

      it('the calendar-month cut-off of the contact messages is the same in every zone, also around the DST changes', async () => {
        const instants = [
          '2026-03-08T07:30:00Z', // New York skips 02:00-03:00
          '2026-03-09T03:30:00Z',
          '2026-11-01T05:30:00Z', // New York repeats 01:00-02:00
          '2026-11-01T06:30:00Z',
          '2026-03-31T00:30:00Z', // end of month: 12 months back and 1 month back
          '2026-05-31T02:00:00Z',
          '2028-02-29T23:59:59Z',
          '2026-10-25T00:30:00Z', // Europe changes; harmless here, but a zone-sensitive expression would show it
        ];
        for (const iso of instants) {
          for (const months of [3, 12, 24]) {
            const task = (z: string) =>
              // the EXACT expression of src/retention/tasks/contact-inquiries.task.ts, evaluated in session zone `z`
              prisma
                .$transaction(async (tx) => {
                  await tx.$executeRawUnsafe(
                    `SELECT set_config('TimeZone', '${z}', true)`,
                  );
                  return tx.$queryRawUnsafe<{ c: string }[]>(
                    `SELECT to_char(((($1::text)::timestamptz AT TIME ZONE 'UTC') - make_interval(months => $2::int)), 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS c`,
                    iso,
                    months,
                  );
                })
                .then((r) => r[0].c);
            const inUtc = await task('UTC');
            expect(
              await task(zone),
              `${iso} - ${months} months in ${zone}`,
            ).toBe(inUtc);
            expect(await task('America/New_York')).toBe(inUtc);
            expect(await task('Asia/Tokyo')).toBe(inUtc);
          }
        }
      });
    });
  },
);
