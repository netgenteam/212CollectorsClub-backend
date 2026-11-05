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
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { UsageLogBuffer } from './../src/usage/usage-log.buffer.js';
import { applyUsageLog } from './../src/usage/usage-log.middleware.js';
import { USAGE_LOG_WRITER } from './../src/usage/usage-log.types.js';
import type { UsageLogRow } from './../src/usage/usage-log.types.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { registerConsent } from './helpers/legal-consent.js';

/**
 * Story 20.6a, round 3 (QA): a login that verified the OLD password, while the account row was held and the password
 * changed in the middle, never leaves a live session. Real database
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

describe(
  'Login with a credential that changed meanwhile (e2e, Story 20.6a)',
  { timeout: 120_000 },
  () => {
    let t: Booted;
    const adminIds: string[] = [];
    const customerIds: string[] = [];
    const uas: string[] = [];
    const flush = async () => {
      await t.buffer.flush(true, true);
    };
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

    // ----------------------------------------------------------------------------------------
    describe('Story 20.6a: a login that verified the OLD password leaves no session', () => {
      it('row held 2 s, password changed in the middle: 401 and no Customer_Sessions row', async () => {
        const c = await mkCustomer('stale');
        const release = await holdCustomerRow(c.id);
        const newHash = await argon2.hash(`NEW${TAG}-another-long`, {
          type: argon2.argon2id,
        });
        const pending = t
          .server()
          .post(`${BASE}/auth/login`)
          .send({ email: c.email, password: PASS });
        const done = pending.then((r) => r);
        await sleep(800);
        await t.prisma.customerAccount.updateMany({
          where: { userId: c.id, providerId: 'credential' },
          data: { password: newHash },
        });
        await sleep(300);
        await release();
        const res = await done;
        expect(res.status).toBe(401);
        const n = await t.prisma.customerSession.count({
          where: { userId: c.id },
        });
        expect(n).toBe(0);
      });

      it('control: with the credential unchanged the same login is 200 with a session', async () => {
        const c = await mkCustomer('fresh');
        const release = await holdCustomerRow(c.id);
        const done = t
          .server()
          .post(`${BASE}/auth/login`)
          .send({ email: c.email, password: PASS })
          .then((r) => r);
        await sleep(500);
        await release();
        const res = await done;
        expect(res.status).toBe(200);
        expect(
          await t.prisma.customerSession.count({ where: { userId: c.id } }),
        ).toBe(1);
      });
    });
  },
);
