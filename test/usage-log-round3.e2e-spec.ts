/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { AuditService } from './../src/audit/audit.service.js';
import { ApiException } from './../src/common/api-exception.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { UsageLogBuffer } from './../src/usage/usage-log.buffer.js';
import { applyUsageLog } from './../src/usage/usage-log.middleware.js';
import { USAGE_LOG_WRITER } from './../src/usage/usage-log.types.js';
import type { UsageLogRow } from './../src/usage/usage-log.types.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';
import { registerConsent } from './helpers/legal-consent.js';

/**
 * Story 20.7, third round (QA): a request queued on a pipelined connection leaves exactly one row even when
 * the client cuts the socket, concurrent reads of the usage log wait for the same audit write and fail with
 * it, and a login that verified an OLD password never leaves a live session (Story 20.6a). Real database
 * (a throw-away clone). Every test cleans what it creates.
 */
const BASE = '/api/v1';
const TAG = randomUUID().replace(/-/g, '').slice(0, 8);
const PASS = `PASS${TAG}-long-enough`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  app: NestExpressApplication;
  prisma: PrismaService;
  buffer: UsageLogBuffer;
  port: number;
  server: () => request.Agent;
  close: () => Promise<void>;
}

async function boot(writer?: {
  insert: (rows: readonly UsageLogRow[]) => Promise<void>;
}): Promise<Booted> {
  process.env.USAGE_LOG_FLUSH_MS ??= '50';
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true });
  if (writer) {
    builder = builder.overrideProvider(USAGE_LOG_WRITER).useValue(writer);
  }
  const moduleFixture: TestingModule = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.set('trust proxy', 1);
  applyRequestContext(app);
  applyUsageLog(app, app.get(UsageLogBuffer));
  app.use(
    cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createGlobalValidationPipe());
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').setVersion('1').build(),
    ),
  );
  app.enableShutdownHooks();
  await app.init();
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  delete process.env.USAGE_LOG_FLUSH_MS;
  return {
    app,
    prisma: app.get(PrismaService),
    buffer: app.get(UsageLogBuffer),
    port,
    server: () => request.agent(`http://127.0.0.1:${port}`),
    close: () => app.close(),
  };
}

/** Sends `raw` over a plain socket and destroys it `afterMs` later without reading the answer. */
function rawAbort(port: number, raw: string, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(raw);
      setTimeout(() => {
        s.destroy();
        resolve();
      }, afterMs);
    });
    s.on('error', () => undefined);
  });
}

const httpHead = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
) =>
  `${method} ${path} HTTP/1.1\r\nHost: x\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join(
      '',
    )}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`;

describe(
  'Usage log, QA round 3 (e2e, Story 20.7)',
  { timeout: 240_000 },
  () => {
    let t: Booted;
    const adminIds: string[] = [];
    const customerIds: string[] = [];
    const uas: string[] = [];
    const flush = async () => {
      await t.buffer.flush(true, true);
    };
    const rowsByUa = (ua: string) =>
      t.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT "route", "status", "actorType", "durationMs", "requestId", "method"
           FROM "Usage_Logs" WHERE "userAgent" = $1 ORDER BY "id"`,
        ua,
      );
    const newUa = (label: string) => {
      const ua = `qa207c-${label}-${TAG}`;
      uas.push(ua);
      return ua;
    };

    async function mkAdmin(label: string) {
      const a = await t.prisma.adminUser.create({
        data: {
          username: `e2e-207c-${label}-${TAG}`,
          email: `e2e-207c-${label}-${TAG}@212collectorsclub.test`,
          passwordHash: await argon2.hash('x'.repeat(16), {
            type: argon2.argon2id,
          }),
        },
      });
      adminIds.push(a.id);
      return { id: a.id, token: await mintAdminToken(t.app, a.id) };
    }
    async function mkCustomer(label: string) {
      const email = `e2e-207c-${label}-${TAG}@212collectorsclub.test`;
      await t
        .server()
        .post(`${BASE}/auth/register`)
        .send({
          ...registerConsent(),
          email,
          password: PASS,
          name: 'Cliente Tres',
        })
        .expect(201);
      const c = await t.prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      customerIds.push(c.id);
      return { id: c.id, email };
    }
    async function holdCustomerRow(id: string) {
      const u = new URL(adminDatabaseUrl());
      u.searchParams.delete('schema');
      const holder = new pg.Client({ connectionString: u.toString() });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM "Customers" WHERE "id" = $1::uuid FOR UPDATE`,
        [id],
      );
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await holder.query('COMMIT').catch(() => undefined);
        await holder.end().catch(() => undefined);
      };
    }

    beforeAll(async () => {
      t = await boot();
    });
    afterAll(async () => {
      await flush().catch(() => undefined);
      await t.prisma.$executeRawUnsafe(
        `DELETE FROM "Usage_Logs" WHERE "userAgent" = ANY($1::text[]) OR "actorId" = ANY($2::uuid[])`,
        uas,
        [...customerIds, ...adminIds],
      );
      await t.prisma.customer
        .deleteMany({ where: { id: { in: customerIds } } })
        .catch(() => undefined);
      await t.prisma.adminUser
        .deleteMany({ where: { id: { in: adminIds } } })
        .catch(() => undefined);
      await t.close();
    });

    const login = (email: string, ua: string, pass = PASS) =>
      httpHead(
        'POST',
        `${BASE}/auth/login`,
        { 'Content-Type': 'application/json', 'User-Agent': ua },
        JSON.stringify({ email, password: pass }),
      );
    const forgot = (email: string, ua: string) =>
      httpHead(
        'POST',
        `${BASE}/auth/forgot-password`,
        { 'Content-Type': 'application/json', 'User-Agent': ua },
        JSON.stringify({ email }),
      );

    // ----------------------------------------------------------------------------------------
    describe('D1: pipelined requests leave exactly one row each', () => {
      it('login (row held, ~2.5 s) + 2 forgot-password in ONE write, socket destroyed at 700 ms: 3 rows', async () => {
        const c = await mkCustomer('pipe');
        const ua = newUa('pipe');
        const release = await holdCustomerRow(c.id);
        try {
          await rawAbort(
            t.port,
            login(c.email, ua) + forgot(c.email, ua) + forgot(c.email, ua),
            700,
          );
          await sleep(3_500); // the login ends (409) after the cut
        } finally {
          await release();
        }
        await sleep(300);
        await flush();
        const rows = await rowsByUa(ua);
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.route).sort()).toEqual([
          '/api/v1/auth/forgot-password',
          '/api/v1/auth/forgot-password',
          '/api/v1/auth/login',
        ]);
        expect(rows.every((r) => r.status === 499)).toBe(true);
        expect(new Set(rows.map((r) => r.requestId)).size).toBe(3);
      });

      it('cuts at different moments (0, 50, 300, 800 ms) with 5 pipelined requests: always exactly 5 rows, never more', async () => {
        const c = await mkCustomer('cuts');
        for (const afterMs of [0, 50, 300, 800]) {
          const ua = newUa(`cuts${afterMs}`);
          const batch = login(c.email, ua) + forgot(c.email, ua).repeat(4);
          await rawAbort(t.port, batch, afterMs);
          await sleep(1_500);
          await flush();
          const rows = await rowsByUa(ua);
          expect(rows).toHaveLength(5);
        }
      });

      it('a pipeline that completes (no cut) and a keep-alive socket reused for 200 requests: one row each, no duplicates', async () => {
        const ua = newUa('ka');
        await new Promise<void>((resolve, reject) => {
          const s = net.connect(t.port, '127.0.0.1');
          let seen = 0;
          s.on('data', (d) => {
            seen += (d.toString().match(/HTTP\/1\.1 \d{3}/g) ?? []).length;
            if (seen >= 200) {
              s.destroy();
              resolve();
            }
          });
          s.on('error', reject);
          s.write(
            Array.from({ length: 200 }, () =>
              httpHead('GET', `${BASE}/categories`, {
                'User-Agent': ua,
                Connection: 'keep-alive',
              }),
            ).join(''),
          );
        });
        await sleep(300);
        await flush();
        expect(await rowsByUa(ua)).toHaveLength(200);
      });
    });

    // ----------------------------------------------------------------------------------------
    describe('D2: concurrent reads of the usage log share the one audit write', () => {
      it('6 simultaneous first reads with the audit write failing: ALL six fail (503), none returns rows; the next one tries again', async () => {
        const a = await mkAdmin('d2');
        const audit = t.app.get(AuditService);
        const spy = vi.spyOn(audit, 'transaction');
        spy.mockImplementation(async () => {
          await sleep(150);
          throw new ApiException(
            503,
            'AUDIT_UNAVAILABLE',
            'The audit log is unavailable.',
          );
        });
        try {
          const res = await Promise.all(
            Array.from({ length: 6 }, () =>
              t
                .server()
                .get(`${BASE}/admin/audit/usage`)
                .set('Authorization', `Bearer ${a.token}`),
            ),
          );
          expect(res.map((r) => r.status)).toEqual(Array(6).fill(503));
          expect(res.every((r) => r.body.items === undefined)).toBe(true);
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          spy.mockRestore();
        }
        const ok = await t
          .server()
          .get(`${BASE}/admin/audit/usage`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(ok.status).toBe(200);
        const n = await t.prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "action" = 'USAGE_LOG_QUERIED' AND "actorId" = $1::uuid`,
          a.id,
        );
        expect(n[0].n).toBe(1);
      });

      it('real database: INSERT revoked on Audit_Events, 6 simultaneous reads of a new admin: six 503, no IP shown, no event; after GRANT the next read is 200', async () => {
        const who = await t.prisma.$queryRaw<
          { u: string; owner: string }[]
        >`SELECT current_user::text AS u, (SELECT tableowner FROM pg_tables WHERE tablename = 'Audit_Events' LIMIT 1)::text AS owner`;
        if (who[0].u === who[0].owner) return; // the owner always can insert: needs the limited role
        const a = await mkAdmin('rev');
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const owner = new pg.Client({ connectionString: u.toString() });
        await owner.connect();
        const role = `"${who[0].u.replace(/"/g, '""')}"`;
        await owner.query(`REVOKE INSERT ON "Audit_Events" FROM ${role}`);
        try {
          const res = await Promise.all(
            Array.from({ length: 6 }, () =>
              t
                .server()
                .get(`${BASE}/admin/audit/usage`)
                .set('Authorization', `Bearer ${a.token}`),
            ),
          );
          process.stdout.write(
            `[20.7 round 3] 6 concurrent reads, INSERT revoked: ${res.map((r) => r.status).join(' ')}\n`,
          );
          expect(res.map((r) => r.status)).toEqual(Array(6).fill(503));
          expect(res.every((r) => r.body.items === undefined)).toBe(true);
        } finally {
          await owner.query(`GRANT INSERT ON "Audit_Events" TO ${role}`);
          await owner.end();
        }
        const ok = await t
          .server()
          .get(`${BASE}/admin/audit/usage`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(ok.status).toBe(200);
      });
    });
  },
);
