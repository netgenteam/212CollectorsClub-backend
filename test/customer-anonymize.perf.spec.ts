/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies and pg rows are untyped JSON */
import { randomUUID } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { appCrypto } from './helpers/iddoc-assert.js';

/**
 * Story 20.6, perf (pnpm test:perf, one file at a time): what an irreversible account anonymization
 * costs for a customer with NO orders and for one with 500, and what the search costs on a large
 * `Customers` table (the cedula search must use the blind indexes, the email search is a scan of a
 * small table). Runs on the throw-away database of the run. Monotonic clock, interleaved samples.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const PASS = 'correct-horse-battery-staple-20-6p';
const BASE = '/api/v1';
const REASON = `Solicitud del titular, ref ${TAG}, 2026-11-04`;
const SAMPLES = Number(process.env.ANON_PERF_SAMPLES ?? 12);
const BIG_ORDERS = Number(process.env.ANON_PERF_ORDERS ?? 500);
const CUSTOMERS = Number(process.env.ANON_PERF_CUSTOMERS ?? 20_000);
const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const out = (s: string): void => void process.stdout.write(`${s}\n`);

describe('anonymization and customer search cost (perf, Story 20.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let base: string;
  let adminId: string;
  let token: string;
  let agencyId: string;
  const server = () => request(base);
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function customerWith(orders: number, i: number) {
    const c = await prisma.customer.create({
      data: {
        email: `e2e-206p-${TAG}-${orders}-${i}@212collectorsclub.test`,
        name: `Perf ${TAG}`,
        phone: '04120000000',
      },
    });
    // what a real account owns: a credential, a few sessions, addresses, a cart, a wishlist, tokens
    await prisma.customerAccount.create({
      data: {
        userId: c.id,
        accountId: c.id,
        providerId: 'credential',
        password: 'x',
      },
    });
    await prisma.customerSession.createMany({
      data: [0, 1, 2].map((k) => ({
        userId: c.id,
        token: `${TAG}-${c.id}-${k}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: '203.0.113.9',
        userAgent: 'perf',
      })),
    });
    for (let k = 0; k < 5; k++) {
      await prisma.customerAddress.create({
        data: {
          customerId: c.id,
          agencyId,
          recipientName: 'P',
          recipientPhone: '04121111111',
          recipientIdDocEnc: appCrypto.protect('V-91234567')?.enc,
          recipientIdDocBlind: appCrypto.protect('V-91234567')?.blind,
          deliveryMode: 'AGENCY_OFFICE',
          state: 'Miranda',
          municipality: 'Chacao',
        },
      });
    }
    await prisma.customerVerification.createMany({
      data: [0, 1].map((k) => ({
        identifier: `${TAG}-${c.id}-${k}`,
        value: c.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      })),
    });
    if (orders > 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Orders" ("id","status","paymentRail","fulfillmentType","recipientName","recipientPhone","totalUsd","accessTokenHash","customerId","updatedAt","createdAt")
         SELECT gen_random_uuid(), (ARRAY['FULFILLED','CANCELLED','EXPIRED','PAYMENT_FAILED','PAYMENT_REJECTED'])[1 + g % 5]::"OrderStatus",
                'PAGO_MOVIL','DELIVERY','Perf','0412',5, gen_random_uuid()::text, $1::uuid, now(), now() - g * interval '1 hour'
           FROM generate_series(1, $2::int) g`,
        c.id,
        orders,
      );
    }
    return c;
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = m.createNestApplication<NestExpressApplication>();
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
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    prisma = app.get(PrismaService);
    agencyId = (await prisma.shippingAgency.findFirstOrThrow()).id;
    const user = `e2e-206p-${TAG}`;
    const admin = await prisma.adminUser.create({
      data: {
        username: user,
        email: `${user}@212collectorsclub.test`,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await server()
      .post(`${BASE}/admin/auth/login`)
      .send({ usernameOrEmail: user, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  }, 120_000);

  afterAll(async () => {
    const ids = (
      await prisma.customer.findMany({
        where: { email: { startsWith: `e2e-206p-${TAG}` } },
        select: { id: true },
      })
    ).map((c) => c.id);
    await prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.adminUser.delete({ where: { id: adminId } });
    await app.close();
  }, 120_000);

  it(`anonymize: a customer with no orders vs one with ${BIG_ORDERS} (${SAMPLES} each, interleaved)`, async () => {
    const small: number[] = [];
    const big: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      for (const [orders, bucket] of [
        [0, small],
        [BIG_ORDERS, big],
      ] as const) {
        const c = await customerWith(orders, i);
        const t = nowMs();
        const r = await server()
          .post(`${BASE}/admin/customers/${c.id}/anonymize`)
          .set(auth())
          .send({ confirmEmail: c.email, reason: REASON });
        bucket.push(nowMs() - t);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.alreadyAnonymized).toBe(false);
      }
    }
    out(
      `[20.6 perf] anonymize HTTP, no orders:   p50=${pct(small, 50).toFixed(1)} p95=${pct(small, 95).toFixed(1)} max=${Math.max(...small).toFixed(1)} ms (n=${small.length})`,
    );
    out(
      `[20.6 perf] anonymize HTTP, ${BIG_ORDERS} orders: p50=${pct(big, 50).toFixed(1)} p95=${pct(big, 95).toFixed(1)} max=${Math.max(...big).toFixed(1)} ms (n=${big.length})`,
    );
    // The 500 orders cost only two COUNT/LIMIT reads through the (customerId, createdAt) index:
    // never anything per order. Budgets are generous (a noisy CI box), the printed numbers are the data.
    expect(pct(small, 95)).toBeLessThan(800);
    expect(pct(big, 95)).toBeLessThan(800);
    expect(pct(big, 50)).toBeLessThan(pct(small, 50) * 3 + 50);
  }, 300_000);

  it('detail with 500 orders and the idempotent repeat are cheap', async () => {
    const c = await customerWith(BIG_ORDERS, 999);
    const det: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = nowMs();
      await server()
        .get(`${BASE}/admin/customers/${c.id}`)
        .set(auth())
        .expect(200);
      det.push(nowMs() - t);
    }
    await server()
      .post(`${BASE}/admin/customers/${c.id}/anonymize`)
      .set(auth())
      .send({ confirmEmail: c.email, reason: REASON })
      .expect(200);
    const rep: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = nowMs();
      const r = await server()
        .post(`${BASE}/admin/customers/${c.id}/anonymize`)
        .set(auth())
        .send({ confirmEmail: 'x', reason: 'x' })
        .expect(200);
      rep.push(nowMs() - t);
      expect(r.body.alreadyAnonymized).toBe(true);
    }
    out(
      `[20.6 perf] detail (${BIG_ORDERS} orders): p50=${pct(det, 50).toFixed(1)} p95=${pct(det, 95).toFixed(1)} ms | idempotent repeat: p50=${pct(rep, 50).toFixed(1)} p95=${pct(rep, 95).toFixed(1)} ms`,
    );
    expect(pct(det, 95)).toBeLessThan(500);
    expect(pct(rep, 95)).toBeLessThan(300);
  }, 120_000);

  it(`search on ${CUSTOMERS} customers: the cedula goes through the blind indexes, email/name is a bounded scan`, async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Customers" ("id","email","name","emailVerified","createdAt","updatedAt")
       SELECT gen_random_uuid(), 'e2e-206p-${TAG}-bulk-' || g || '@212collectorsclub.test', 'Bulk ${TAG} ' || g, false,
              now() - g * interval '1 minute', now()
         FROM generate_series(1, $1::int) g`,
      CUSTOMERS,
    );
    await prisma.$executeRawUnsafe(`ANALYZE "Customers"`);
    const ced = appCrypto.protect('V-98765432');
    const target = (
      await prisma.customer.findFirstOrThrow({
        where: { email: { startsWith: `e2e-206p-${TAG}-bulk-77@` } },
      })
    ).id;
    await prisma.order.create({
      data: {
        status: 'FULFILLED',
        customerId: target,
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'DELIVERY',
        recipientName: 'X',
        recipientPhone: '0412',
        totalUsd: '5.00',
        accessTokenHash: randomUUID(),
        recipientIdDocEnc: ced?.enc,
        recipientIdDocBlind: ced?.blind,
      },
    });
    const time = async (body: Record<string, unknown>): Promise<number> => {
      const t = nowMs();
      await server()
        .post(`${BASE}/admin/customers/search`)
        .set(auth())
        .send(body)
        .expect(200);
      return nowMs() - t;
    };
    const idDoc: number[] = [];
    const q: number[] = [];
    const page: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      idDoc.push(await time({ idDoc: 'V-98765432' }));
      q.push(await time({ q: `bulk-${i + 100}@` }));
      page.push(await time({}));
    }
    out(
      `[20.6 perf] search over ${CUSTOMERS + 1} customers: idDoc p50=${pct(idDoc, 50).toFixed(1)} p95=${pct(idDoc, 95).toFixed(1)} | q p50=${pct(q, 50).toFixed(1)} p95=${pct(q, 95).toFixed(1)} | first page p50=${pct(page, 50).toFixed(1)} p95=${pct(page, 95).toFixed(1)} ms`,
    );
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (FORMAT TEXT) SELECT "customerId"::text FROM "Orders" WHERE "recipientIdDocBlind" = $1 AND "customerId" IS NOT NULL
        UNION SELECT "customerId"::text FROM "Orders" WHERE "buyerIdDocBlind" = $1 AND "customerId" IS NOT NULL
        UNION SELECT "customerId"::text FROM "Customer_Addresses" WHERE "recipientIdDocBlind" = $1 LIMIT 1000`,
      ced?.blind,
    );
    out(
      `[20.6 perf] cedula plan:\n${plan.map((r) => r['QUERY PLAN']).join('\n')}`,
    );
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toMatch(
      /Index (Only )?Scan|Bitmap Index Scan/,
    );
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).not.toMatch(
      /Seq Scan on "(Orders|Customer_Addresses)"/,
    );
    expect(pct(idDoc, 95)).toBeLessThan(300);
    expect(pct(q, 95)).toBeLessThan(500);
    expect(pct(page, 95)).toBeLessThan(300);
  }, 300_000);
});
