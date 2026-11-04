import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AUDIT_ACTIONS } from './../src/audit/audit-actions.js';
import type { AuditAction } from './../src/audit/audit-actions.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import { sanitizeAuditPayload } from './../src/audit/audit-payload.js';
import { publicFieldsOf } from './../src/audit/audit-actions.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';
import { blockAuditAction } from './helpers/block-audit-action.js';
import { AdminLoginFailureSummary } from './../src/admin-auth/admin-login-failure-summary.js';
import { CUSTOMER_AUTH } from './../src/auth-core/auth-core.constants.js';
import type { CustomerAuth } from './../src/auth-core/customer-auth.factory.js';
import { TcgSyncRunService } from './../src/tcg/tcg-sync-run.service.js';
import { join } from 'node:path';
import { withBuyerId } from './helpers/buyer-id.js';
import {
  seedConsentDocs,
  type SeededConsent,
} from './helpers/legal-consent.js';
import {
  createSandboxDocument,
  purgeSandbox,
} from './helpers/legal-sandbox.js';

/**
 * Story 20.5 (AD-99, FR-139): the audit events emitted by the real actions, on the real
 * stack. It runs on the THROW-AWAY database every e2e run gets (global-test-db.ts), so nothing
 * here can leave an undeletable row anywhere that matters.
 *
 *  - AC1 Pago Movil confirm / reject, and FAIL-CLOSED (a real INSERT failure rolls the
 *    confirmation back: status, stock, holds, history);
 *  - AC2 Stripe webhook: one event per real state change, a concurrent duplicate emits once;
 *  - AC3 order status, tracking, price, stock, shipping agencies;
 *  - AC4 admin login OK (fail-closed) / FAILED (best-effort, hashed, bounded) / logout;
 *  - AC5 FX and vitrina; AC6 legal publish, identity, consent (one event per call);
 *  - AC8 real concurrency and crossings: linear chain verified by `AuditChainVerifier`, no 5xx,
 *    and a PII sweep over every event emitted in the run.
 */
// 20.5 fix: the tag lands in names/codes that the PII sweep scans. A hex tag starting with `e`
// followed by 7 digits (`Agencia e1234567`) is a legitimate-looking cedula to the sweep regex
// (about 1 run in 500): the tag starts with a letter outside [VEJGP] and has no digit run.
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const PASS = 'correct-horse-battery-staple-20-5';
const BASE = '/api/v1';

// Sentinels that must NEVER reach `Audit_Events` (AC8 PII sweep).
const S_CEDULA = 'V-87654321';
const S_CEDULA_DIGITS = '87654321';
const S_PHONE = '0412-9990001';
const S_ADDRESS = 'Calle Sentinela 99';
const S_NAME = 'Persona Sentinela';
const S_EMAIL = `sentinela-${TAG}@pii.test`;

type Row = {
  seq: number;
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
};

describe('Audit event emission (e2e, Story 20.5)', { timeout: 60_000 }, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let categoryId: string;
  let adminId: string;
  let token: string;
  let savedFx: FxState;
  const productIds: string[] = [];
  const agencyIds: string[] = [];
  const emails: string[] = [];
  const startSeq = { v: 0 };
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const ADMIN_USER = `e2e-emit-${TAG}`;
  const ADMIN_EMAIL = `${ADMIN_USER}@212collectorsclub.test`;
  const secret = () =>
    app.get(ConfigService).get<string>('STRIPE_WEBHOOK_SECRET') ||
    FAKE_STRIPE_WEBHOOK_SECRET;

  const head = async (): Promise<number> =>
    Number(
      (
        await sql(
          `SELECT COALESCE(max("seq"), 0)::int AS s FROM "Audit_Events"`,
        )
      )[0].s,
    );
  const eventsAfter = async (since: number, action?: string): Promise<Row[]> =>
    (await sql(
      `SELECT "seq"::int AS "seq", "action", "actorType", "actorId"::text AS "actorId", "entityType", "entityId",
              "before", "after", "reason", "requestId"::text AS "requestId", host("ip") AS "ip"
         FROM "Audit_Events" WHERE "seq" > $1 AND ($2::text IS NULL OR "action" = $2) ORDER BY "seq"`,
      [since, action ?? null],
    )) as unknown as Row[];
  const waitFor = async <T>(
    fn: () => Promise<T | null | false>,
    ms = 5_000,
  ) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const blockAction = blockAuditAction;

  const cookieOf = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  let n = 0;
  async function mkProduct(
    o: { price?: string; stock?: number; name?: string } = {},
  ): Promise<string> {
    const i = ++n;
    const p = await prisma.product.create({
      data: {
        name: o.name ?? `Emit${TAG} ${i}`,
        slug: `emit${TAG}-${i}`.toLowerCase(),
        description: 'Created by e2e 20.5.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: o.price ?? '10.00',
        stock: o.stock ?? 50,
        heldQty: 0,
        isActive: true,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** A REAL checkout; sentinel PII in the body proves it never reaches the audit log. */
  async function checkout(
    productId: string,
    rail: 'pago_movil' | 'stripe' = 'pago_movil',
    extra: Record<string, unknown> = {},
    cookie?: string,
    qty = 1,
  ): Promise<{ orderId: string; token: string; sessionId?: string }> {
    const cart =
      cookie ??
      cookieOf(
        await request(server())
          .post(`${BASE}/cart/items`)
          .send({ productId, quantity: qty })
          .expect(201),
        'cartId',
      );
    const res = await request(server())
      .post(`${BASE}/checkout`)
      .set('Cookie', cart)
      .send(
        withBuyerId({
          paymentRail: rail,
          fulfillmentType: 'delivery',
          addressLine1: S_ADDRESS,
          city: 'Caracas',
          state: 'Distrito Capital',
          recipientName: S_NAME,
          recipientPhone: S_PHONE,
          recipientIdDoc: S_CEDULA,
          ...extra,
        }),
      );
    expect([201, res.status, res.text]).toEqual([201, 201, res.text]);
    const b = res.body as {
      orderId: string;
      orderAccessToken: string;
      stripe?: { sessionId: string } | null;
    };
    return {
      orderId: b.orderId,
      token: b.orderAccessToken,
      sessionId: b.stripe?.sessionId,
    };
  }

  const confirm = (orderId: string) =>
    request(server())
      .post(`${BASE}/admin/orders/${orderId}/confirm-payment`)
      .set(auth());
  const reject = (orderId: string) =>
    request(server())
      .post(`${BASE}/admin/orders/${orderId}/reject-payment`)
      .set(auth());

  const webhookBody = (
    type: string,
    sessionId: string,
    orderId: string,
    amount: number,
    id = `evt_${TAG}_${randomUUID()}`,
  ) =>
    JSON.stringify({
      id,
      object: 'event',
      type,
      data: {
        object: {
          object: 'checkout.session',
          id: sessionId,
          client_reference_id: orderId,
          metadata: { orderId },
          payment_status: 'paid',
          amount_total: amount,
          currency: 'usd',
          payment_intent: 'pi_test_20_5',
        },
      },
    });
  const sendWebhook = (payload: string) =>
    request(server())
      .post(`${BASE}/payments/stripe/webhook`)
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: secret(),
        }),
      )
      .send(payload);

  const savedBudget = process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE;

  beforeAll(async () => {
    // The instance-wide LOGIN_ADMIN_FAILED budget has its own test below; the rest must not trip it.
    process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1000';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
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
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
    await app.init();
    prisma = app.get(PrismaService);
    startSeq.v = await head();
    savedFx = await snapshotFx(prisma);
    categoryId = (await prisma.category.findFirstOrThrow()).id;

    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    const admin = await prisma.adminUser.create({
      data: { username: ADMIN_USER, email: ADMIN_EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await request(server())
      .post(`${BASE}/admin/auth/login`)
      .send({ usernameOrEmail: ADMIN_USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    if (savedBudget === undefined)
      delete process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE;
    else process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = savedBudget;
    await restoreFx(prisma, savedFx).catch(() => undefined);
    await prisma.order
      .deleteMany({
        where: { lines: { some: { productId: { in: productIds } } } },
      })
      .catch(() => undefined);
    await prisma.cart
      .deleteMany({
        where: { items: { some: { productId: { in: productIds } } } },
      })
      .catch(() => undefined);
    await prisma.product
      .deleteMany({ where: { id: { in: productIds } } })
      .catch(() => undefined);
    await prisma.shippingAgency
      .deleteMany({ where: { id: { in: agencyIds } } })
      .catch(() => undefined);
    await prisma.customer
      .deleteMany({ where: { email: { in: emails } } })
      .catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  // ─── AC4 ────────────────────────────────────────────────────────────────
  describe('AC4: admin session', () => {
    it('the login of the fixture wrote LOGIN_ADMIN_OK with actor, entity, session id, request id and ip', async () => {
      const rows = (await eventsAfter(startSeq.v, 'LOGIN_ADMIN_OK')).filter(
        (r) => r.actorId === adminId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'ADMIN',
        entityType: 'AdminUser',
        entityId: adminId,
        after: { adminId, method: 'password' },
      });
      expect(rows[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0].ip).toBeTruthy();
    });

    it('LOGIN_ADMIN_OK is fail-closed: 503 AUDIT_UNAVAILABLE, and NO session is left behind', async () => {
      const before = Number(
        (
          await sql(
            `SELECT count(*)::int AS n FROM "Admin_Sessions" WHERE "userId" = $1::uuid`,
            [adminId],
          )
        )[0].n,
      );
      const res = await blockAction('LOGIN_ADMIN_OK', () =>
        request(server())
          .post(`${BASE}/admin/auth/login`)
          .send({ usernameOrEmail: ADMIN_USER, password: PASS }),
      );
      expect(res.status).toBe(503);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'AUDIT_UNAVAILABLE',
      );
      expect(res.body).not.toHaveProperty('accessToken');
      const after = Number(
        (
          await sql(
            `SELECT count(*)::int AS n FROM "Admin_Sessions" WHERE "userId" = $1::uuid`,
            [adminId],
          )
        )[0].n,
      );
      expect(after).toBe(before);
    });

    it('LOGIN_ADMIN_FAILED: the 401 is the same for an unknown user and a wrong password; the event hashes what was typed', async () => {
      const since = await head();
      const typed = `Ghost.${TAG}@Example.com`;
      const a = await request(server())
        .post(`${BASE}/admin/auth/login`)
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ usernameOrEmail: typed, password: 'nope-nope-nope' });
      const b = await request(server())
        .post(`${BASE}/admin/auth/login`)
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ usernameOrEmail: ADMIN_USER, password: 'nope-nope-nope' });
      expect([a.status, b.status]).toEqual([401, 401]);
      expect(a.body).toEqual(b.body);
      const rows = await waitFor(async () => {
        const r = await eventsAfter(since, 'LOGIN_ADMIN_FAILED');
        return r.length >= 2 ? r : null;
      });
      expect(rows[0]).toMatchObject({
        actorType: 'ANON',
        actorId: null,
        after: { reason: 'UNKNOWN_USER', adminFound: false },
      });
      expect((rows[0].after as { emailHash: string }).emailHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(rows[1]).toMatchObject({
        entityId: adminId,
        after: { reason: 'BAD_PASSWORD', adminFound: true },
      });
      expect(JSON.stringify(rows)).not.toContain(typed);
      expect(JSON.stringify(rows).toLowerCase()).not.toContain('ghost');
    });

    it('LOGIN_ADMIN_FAILED is best-effort: with the audit write failing the answer is still the plain 401', async () => {
      const res = await blockAction('LOGIN_ADMIN_FAILED', () =>
        request(server())
          .post(`${BASE}/admin/auth/login`)
          .send({
            usernameOrEmail: `nobody-${TAG}`,
            password: 'nope-nope-nope',
          }),
      );
      expect(res.status).toBe(401);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'INVALID_ADMIN_CREDENTIALS',
      );
    });

    it('no timing oracle: unknown user vs wrong password differ by far less than the Argon2 cost (measured)', async () => {
      const prev = {
        u: process.env.ADMIN_LOGIN_MAX_FAILURES_PER_USER,
        i: process.env.ADMIN_LOGIN_MAX_FAILURES_PER_IP,
      };
      process.env.ADMIN_LOGIN_MAX_FAILURES_PER_USER = '100000';
      process.env.ADMIN_LOGIN_MAX_FAILURES_PER_IP = '100000';
      try {
        const t = async (user: string) => {
          const s = performance.now();
          await request(server())
            .post(`${BASE}/admin/auth/login`)
            .set('X-Forwarded-For', '198.51.100.9')
            .send({ usernameOrEmail: user, password: 'nope-nope-nope' })
            .expect(401);
          return performance.now() - s;
        };
        const med = (xs: number[]) =>
          [...xs].sort((a, b) => a - b)[xs.length >> 1];
        const known: number[] = [];
        const unknown: number[] = [];
        await t(ADMIN_USER); // warm-up
        for (let i = 0; i < 9; i++) {
          known.push(await t(ADMIN_USER));
          unknown.push(await t(`nobody-${TAG}-${i}`));
        }
        const [k, u] = [med(known), med(unknown)];
        console.log(
          `[20.5 timing] median known-user wrong password ${k.toFixed(1)} ms, unknown user ${u.toFixed(1)} ms`,
        );
        // Both pay one Argon2id verify (tens of ms): a gap above 35% would be an oracle.
        expect(Math.abs(k - u) / Math.max(k, u)).toBeLessThan(0.35);
      } finally {
        for (const [key, v] of [
          ['ADMIN_LOGIN_MAX_FAILURES_PER_USER', prev.u],
          ['ADMIN_LOGIN_MAX_FAILURES_PER_IP', prev.i],
        ] as const) {
          if (v === undefined) delete process.env[key];
          else process.env[key] = v;
        }
      }
    });

    it('R4: 5 failures for the same user from the same IP => 429 BEFORE hashing; another user is unaffected; the event budget bounds the chain writes', async () => {
      const since = await head();
      const user = `victim-${TAG}`;
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await request(server())
          .post(`${BASE}/admin/auth/login`)
          .set('X-Forwarded-For', '203.0.113.7')
          .send({ usernameOrEmail: user, password: 'nope-nope-nope' });
        statuses.push(r.status);
        if (r.status === 429) {
          expect((r.body as { errorCode: string }).errorCode).toBe(
            'ADMIN_LOGIN_RATE_LIMITED',
          );
        }
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
      // The 429 never reaches the password check and writes no event.
      await waitFor(async () => {
        const r = (await eventsAfter(since, 'LOGIN_ADMIN_FAILED')).filter(
          (x) => x.ip === '203.0.113.7',
        );
        return r.length >= 5 ? r : null;
      });
      await new Promise((r) => setTimeout(r, 300));
      // (events of the previous test's unawaited best-effort writes may still land: select by ip)
      const mine = (await eventsAfter(since, 'LOGIN_ADMIN_FAILED')).filter(
        (r) => r.ip === '203.0.113.7',
      );
      expect(mine).toHaveLength(5);
      // A different user name from another IP still gets its 401.
      await request(server())
        .post(`${BASE}/admin/auth/login`)
        .set('X-Forwarded-For', '203.0.113.8')
        .send({ usernameOrEmail: user, password: 'nope-nope-nope' })
        .expect(401);
    });

    it('R4: a flood from 40 different IPs cannot feed the chain faster than the budget (events dropped, 401 untouched)', async () => {
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '6';
      try {
        // let the budget window of earlier tests expire is not possible in a test: use a fresh minute
        const limiter = app.get(
          (await import('./../src/admin-auth/admin-login-limiter.js'))
            .AdminLoginLimiter,
        );
        (
          limiter as unknown as { eventsWindowStart: number }
        ).eventsWindowStart = 0;
        const since = await head();
        const droppedBefore = limiter.droppedEvents;
        const res: request.Response[] = [];
        for (let i = 0; i < 40; i++) {
          res.push(
            await request(server())
              .post(`${BASE}/admin/auth/login`)
              .set('X-Forwarded-For', `192.0.2.${i + 1}`)
              .send({
                usernameOrEmail: `flood-${i}-${TAG}`,
                password: 'nope-nope-nope',
              }),
          );
        }
        expect(res.map((r) => r.status)).toEqual(Array(40).fill(401));
        await new Promise((r) => setTimeout(r, 1_000));
        const written = (await eventsAfter(since, 'LOGIN_ADMIN_FAILED')).filter(
          (r) => r.ip?.startsWith('192.0.2.'),
        );
        const dropped = limiter.droppedEvents - droppedBefore;
        console.log(
          `[20.5 login flood] 40 failed logins from 40 IPs -> ${written.length} events written, ${dropped} dropped (budget 6/min)`,
        );
        expect(written.length).toBeLessThanOrEqual(6);
        expect(written.length).toBeGreaterThan(0);
        expect(written.length + dropped).toBe(40);
        // what the budget threw away is not lost: ONE summary counts it (hashed identifiers)
        await app.get(AdminLoginFailureSummary).flush();
        const sum = await eventsAfter(since, 'LOGIN_ADMIN_FAILED_SUMMARY');
        expect(sum).toHaveLength(1);
        expect(sum[0]).toMatchObject({
          actorType: 'SYSTEM',
          after: { dropped },
        });
        expect(JSON.stringify(sum)).not.toContain(`flood-`);
      } finally {
        process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1000';
      }
    });

    it('LOGOUT_ADMIN: one event, and a repeat is a 401 that emits nothing', async () => {
      const login = await request(server())
        .post(`${BASE}/admin/auth/login`)
        .send({ usernameOrEmail: ADMIN_USER, password: PASS })
        .expect(200);
      const t = (login.body as { accessToken: string }).accessToken;
      const since = await head();
      await request(server())
        .post(`${BASE}/admin/auth/logout`)
        .set('Authorization', `Bearer ${t}`)
        .expect(204);
      await request(server())
        .post(`${BASE}/admin/auth/logout`)
        .set('Authorization', `Bearer ${t}`)
        .expect(401);
      const rows = await eventsAfter(since, 'LOGOUT_ADMIN');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'ADMIN', actorId: adminId });
    });

    it('a logout is NEVER refused because the audit log is down: the session is revoked anyway (an error is logged) and the answer is 204', async () => {
      const login = await request(server())
        .post(`${BASE}/admin/auth/login`)
        .send({ usernameOrEmail: ADMIN_USER, password: PASS })
        .expect(200);
      const t = (login.body as { accessToken: string }).accessToken;
      const since = await head();
      const res = await blockAction('LOGOUT_ADMIN', () =>
        request(server())
          .post(`${BASE}/admin/auth/logout`)
          .set('Authorization', `Bearer ${t}`),
      );
      expect(res.status).toBe(204);
      // the session is really gone: the same token is now a 401
      await request(server())
        .get(`${BASE}/admin/auth/me`)
        .set('Authorization', `Bearer ${t}`)
        .expect(401);
      // not audited (the write failed): no event, and the answer did not depend on it
      expect(await eventsAfter(since, 'LOGOUT_ADMIN')).toEqual([]);
    });
  });

  // ─── AC1 ────────────────────────────────────────────────────────────────
  describe('AC1: Pago Movil', () => {
    it('confirm emits PAYMENT_PAGO_MOVIL_CONFIRMED in the same transaction; reject emits ..._REJECTED', async () => {
      const p = await mkProduct({ price: '12.50' });
      const o1 = await checkout(p);
      const o2 = await checkout(p);
      const since = await head();
      await confirm(o1.orderId).expect(200);
      await reject(o2.orderId).expect(200);
      const c = await eventsAfter(since, 'PAYMENT_PAGO_MOVIL_CONFIRMED');
      const r = await eventsAfter(since, 'PAYMENT_PAGO_MOVIL_REJECTED');
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        actorType: 'ADMIN',
        actorId: adminId,
        entityType: 'Order',
        entityId: o1.orderId,
        after: {
          orderId: o1.orderId,
          orderStatus: 'PAID',
          previousStatus: 'PENDING_VERIFICATION',
          amountUsd: '12.5',
          stockCommitted: 1,
        },
      });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({
        entityId: o2.orderId,
        after: { orderStatus: 'PAYMENT_REJECTED', holdsReleased: 1 },
      });
      // a duplicate click is a 409 and emits nothing
      await confirm(o1.orderId).expect(409);
      expect(
        await eventsAfter(since, 'PAYMENT_PAGO_MOVIL_CONFIRMED'),
      ).toHaveLength(1);
    });

    it('fail-closed: if the audit INSERT fails the confirmation reverts (status, stock, holds, history) and answers 503', async () => {
      const p = await mkProduct({ stock: 10 });
      const o = await checkout(p, 'pago_movil', {}, undefined, 2);
      const snap = async () => ({
        order: await prisma.order.findUniqueOrThrow({
          where: { id: o.orderId },
          select: { status: true },
        }),
        product: await prisma.product.findUniqueOrThrow({
          where: { id: p },
          select: { stock: true, heldQty: true },
        }),
        holds: await prisma.stockHold.count({
          where: { orderId: o.orderId, releasedAt: null },
        }),
        history: await prisma.orderStatusHistory.count({
          where: { orderId: o.orderId },
        }),
      });
      const before = await snap();
      expect(before.order.status).toBe('PENDING_VERIFICATION');
      const res = await blockAction('PAYMENT_PAGO_MOVIL_CONFIRMED', () =>
        confirm(o.orderId),
      );
      expect(res.status).toBe(503);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'AUDIT_UNAVAILABLE',
      );
      expect(await snap()).toEqual(before);
      // and it works once the audit is back
      await confirm(o.orderId).expect(200);
      expect((await snap()).order.status).toBe('PAID');
    });
  });

  // ─── AC2 ────────────────────────────────────────────────────────────────
  describe('AC2: Stripe webhook', () => {
    it('a paid event emits ONE STRIPE_PAYMENT_STATE_CHANGED; the same event delivered concurrently emits once and the rest are duplicates', async () => {
      const p = await mkProduct({ price: '10.00' });
      const o = await checkout(p, 'stripe', {}, undefined, 2);
      const since = await head();
      const body = webhookBody(
        'checkout.session.completed',
        o.sessionId as string,
        o.orderId,
        2000,
      );
      const t0 = performance.now();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => sendWebhook(body)),
      );
      const ms = performance.now() - t0;
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      const outcomes = results.map(
        (r) => (r.body as { outcome: string }).outcome,
      );
      expect(outcomes.filter((x) => x === 'paid')).toHaveLength(1);
      expect(outcomes.filter((x) => x === 'duplicate')).toHaveLength(5);
      const rows = await eventsAfter(since, 'STRIPE_PAYMENT_STATE_CHANGED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'SYSTEM',
        entityId: o.orderId,
        after: {
          from: 'PAYMENT_PROCESSING',
          to: 'PAID',
          amountUsd: '20',
          paymentIntentId: 'pi_test_20_5',
        },
      });
      console.log(
        `[20.5 webhook] 6 concurrent deliveries answered in ${ms.toFixed(0)} ms`,
      );
      expect(ms).toBeLessThan(5_000);
    });

    it('an expired session emits the failure transition; an unknown or ignored event emits nothing', async () => {
      const p = await mkProduct();
      const o = await checkout(p, 'stripe');
      const since = await head();
      await sendWebhook(
        webhookBody(
          'checkout.session.expired',
          o.sessionId as string,
          o.orderId,
          1000,
        ),
      ).expect(200);
      await sendWebhook(
        JSON.stringify({
          id: `evt_${TAG}_${randomUUID()}`,
          object: 'event',
          type: 'customer.created',
          data: { object: { object: 'customer', id: 'cus_1' } },
        }),
      ).expect(200);
      const rows = await eventsAfter(since, 'STRIPE_PAYMENT_STATE_CHANGED');
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        from: 'PAYMENT_PROCESSING',
        to: 'PAYMENT_FAILED',
      });
    });
  });

  // ─── AC3 ────────────────────────────────────────────────────────────────
  describe('AC3: orders, catalog, shipping', () => {
    it('fulfill and cancel emit ORDER_STATUS_CHANGED; tracking emits ORDER_TRACKING_CHANGED with Order_Tracking_Events kept', async () => {
      const p = await mkProduct({ stock: 20 });
      const a = await checkout(p);
      const b = await checkout(p);
      await confirm(a.orderId).expect(200);
      await confirm(b.orderId).expect(200);
      const since = await head();
      await request(server())
        .post(`${BASE}/admin/orders/${a.orderId}/fulfill`)
        .set(auth())
        .expect(200);
      await request(server())
        .post(`${BASE}/admin/orders/${b.orderId}/cancel`)
        .set(auth())
        .expect(200);
      await request(server())
        .patch(`${BASE}/admin/orders/${a.orderId}/tracking`)
        .set(auth())
        .send({ trackingNumber: 'MRW0012345' })
        .expect(200);
      // the same value again is not a change
      await request(server())
        .patch(`${BASE}/admin/orders/${a.orderId}/tracking`)
        .set(auth())
        .send({ trackingNumber: 'MRW0012345' })
        .expect(200);
      const st = await eventsAfter(since, 'ORDER_STATUS_CHANGED');
      expect(
        st.map((r) => [r.entityId, (r.after as { status: string }).status]),
      ).toEqual([
        [a.orderId, 'FULFILLED'],
        [b.orderId, 'CANCELLED'],
      ]);
      expect(st[0].before).toEqual({ status: 'PAID' });
      const tr = await eventsAfter(since, 'ORDER_TRACKING_CHANGED');
      expect(tr).toHaveLength(1);
      expect(tr[0]).toMatchObject({
        entityId: a.orderId,
        before: { trackingNumber: null },
        after: { trackingNumber: 'MRW0012345' },
      });
      expect(
        await prisma.orderTrackingEvent.count({
          where: { orderId: a.orderId },
        }),
      ).toBe(1);
    });

    it('fail-closed for fulfill: 503 and the order stays PAID', async () => {
      const p = await mkProduct();
      const o = await checkout(p);
      await confirm(o.orderId).expect(200);
      const res = await blockAction('ORDER_STATUS_CHANGED', () =>
        request(server())
          .post(`${BASE}/admin/orders/${o.orderId}/fulfill`)
          .set(auth()),
      );
      expect(res.status).toBe(503);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } }))
          .status,
      ).toBe('PAID');
    });

    it('manual price and stock changes emit PRODUCT_PRICE_CHANGED / PRODUCT_STOCK_ADJUSTED (money as strings); a no-op emits nothing', async () => {
      const p = await mkProduct({ price: '10.00', stock: 5 });
      const since = await head();
      await request(server())
        .patch(`${BASE}/admin/products/${p}`)
        .set(auth())
        .send({ priceUsd: 12.5 })
        .expect(200);
      await request(server())
        .patch(`${BASE}/admin/products/${p}`)
        .set(auth())
        .send({ priceUsd: 12.5, name: `Emit${TAG} renamed` })
        .expect(200);
      await request(server())
        .patch(`${BASE}/admin/products/${p}/stock`)
        .set(auth())
        .send({ stock: 9 })
        .expect(200);
      const price = await eventsAfter(since, 'PRODUCT_PRICE_CHANGED');
      expect(price).toHaveLength(1);
      expect(price[0]).toMatchObject({
        actorId: adminId,
        entityId: p,
        before: { priceUsd: '10' },
        after: { priceUsd: '12.5', previousPriceUsd: '10' },
      });
      const stock = await eventsAfter(since, 'PRODUCT_STOCK_ADJUSTED');
      expect(stock).toHaveLength(1);
      expect(stock[0].after).toMatchObject({
        stock: 9,
        previousStock: 5,
        delta: 4,
      });
    });

    it('product create / isActive change / delete emit PRODUCT_CREATED / PRODUCT_ACTIVE_CHANGED / PRODUCT_DELETED (ids and money only); no-ops and a failed audit emit nothing and change nothing', async () => {
      const create = (slug: string) =>
        request(server())
          .post(`${BASE}/admin/products`)
          .set(auth())
          .field('name', `Emit${TAG} created`)
          .field('slug', slug)
          .field('description', 'created by the audit e2e')
          .field('franchise', 'POKEMON')
          .field('productType', 'SINGLE_CARD')
          .field('rarity', 'COMMON')
          .field('priceUsd', '19.99')
          .field('stock', '4')
          .field('categoryId', categoryId)
          .attach(
            'images',
            join(import.meta.dirname, 'fixtures', 'product-image-fixture.png'),
          );
      const since = await head();
      const created = await create(`emit${TAG}-created`);
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      productIds.push(id);
      const c = await eventsAfter(since, 'PRODUCT_CREATED');
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        actorType: 'ADMIN',
        actorId: adminId,
        entityType: 'Product',
        entityId: id,
        before: null,
        after: {
          productId: id,
          priceUsd: '19.99',
          stock: 4,
          isActive: true,
          categoryId,
          via: 'MANUAL',
        },
      });
      // no title / slug / description in the event
      expect(JSON.stringify(c[0])).not.toContain(`emit${TAG}-created`);

      // isActive: a real transition emits, the same value again does not
      const patch = (body: object) =>
        request(server())
          .patch(`${BASE}/admin/products/${id}`)
          .set(auth())
          .send(body);
      const s2 = await head();
      await patch({ isActive: false }).expect(200);
      await patch({ isActive: false }).expect(200);
      await patch({ isActive: true }).expect(200);
      const act = await eventsAfter(s2, 'PRODUCT_ACTIVE_CHANGED');
      expect(
        act.map((r) => (r.after as { isActive: boolean }).isActive),
      ).toEqual([false, true]);
      expect(act[0]).toMatchObject({
        actorId: adminId,
        before: { isActive: true },
        after: { productId: id, via: 'UPDATE' },
      });

      // fail-closed: the audit write fails => 503 and the product is NOT created
      const blocked = await blockAction('PRODUCT_CREATED', () =>
        create(`emit${TAG}-blocked`),
      );
      expect(blocked.status).toBe(503);
      expect(
        await prisma.product.count({ where: { slug: `emit${TAG}-blocked` } }),
      ).toBe(0);
      // ... and for isActive: the product keeps its state
      const hidden = await blockAction('PRODUCT_ACTIVE_CHANGED', () =>
        patch({ isActive: false }),
      );
      expect(hidden.status).toBe(503);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id } })).isActive,
      ).toBe(true);

      // delete of a product nobody referenced: a real DELETE, one event with what it was
      const s3 = await head();
      const del = await request(server())
        .delete(`${BASE}/admin/products/${id}`)
        .set(auth())
        .expect(200);
      expect(del.body).toMatchObject({ id, hardDeleted: true });
      const d = await eventsAfter(s3, 'PRODUCT_DELETED');
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        actorId: adminId,
        entityId: id,
        before: {
          priceUsd: '19.99',
          stock: 4,
          isActive: true,
          fromMasterCard: false,
        },
        after: null,
      });

      // a product with history cannot be deleted: it is deactivated (and THAT is the event)
      const kept = await mkProduct({ stock: 5 });
      await checkout(kept);
      const s4 = await head();
      const soft = await request(server())
        .delete(`${BASE}/admin/products/${kept}`)
        .set(auth())
        .expect(200);
      expect(soft.body).toMatchObject({ id: kept, hardDeleted: false });
      expect(await eventsAfter(s4, 'PRODUCT_DELETED')).toEqual([]);
      const fb = await eventsAfter(s4, 'PRODUCT_ACTIVE_CHANGED');
      expect(fb).toHaveLength(1);
      expect(fb[0]).toMatchObject({
        entityId: kept,
        before: { isActive: true },
        after: { isActive: false, via: 'DELETE_FALLBACK' },
      });
      // fail-closed delete: the audit write fails => 503 and the row is still there
      const other = await mkProduct({ stock: 1 });
      const refused = await blockAction('PRODUCT_DELETED', () =>
        request(server()).delete(`${BASE}/admin/products/${other}`).set(auth()),
      );
      expect(refused.status).toBe(503);
      expect(await prisma.product.count({ where: { id: other } })).toBe(1);
    });

    it('shipping agency create / edit / delete emit SHIPPING_AGENCY_CHANGED; a no-op edit does not', async () => {
      const since = await head();
      const created = await request(server())
        .post(`${BASE}/admin/shipping/agencies`)
        .set(auth())
        .send({ name: `Agencia ${TAG}`, code: `AG${TAG}`.toUpperCase() })
        .expect(201);
      const id = (created.body as { id: string }).id;
      agencyIds.push(id);
      await request(server())
        .patch(`${BASE}/admin/shipping/agencies/${id}`)
        .set(auth())
        .send({ name: `Agencia ${TAG} 2`, isActive: false })
        .expect(200);
      await request(server())
        .patch(`${BASE}/admin/shipping/agencies/${id}`)
        .set(auth())
        .send({ name: `Agencia ${TAG} 2` })
        .expect(200);
      await request(server())
        .delete(`${BASE}/admin/shipping/agencies/${id}`)
        .set(auth())
        .expect(204);
      const rows = await eventsAfter(since, 'SHIPPING_AGENCY_CHANGED');
      expect(
        rows.map((r) => (r.after as { operation: string }).operation),
      ).toEqual(['CREATE', 'UPDATE', 'DELETE']);
      expect(rows[1]).toMatchObject({
        before: { name: `Agencia ${TAG}`, isActive: true },
        after: { name: `Agencia ${TAG} 2`, isActive: false },
      });
    });
  });

  // ─── follow-up: risk actions that had no event ────────────────────────────
  describe('follow-up: customer accounts, data imports and Stripe refunds pending', () => {
    it('a customer password reset emits CUSTOMER_PASSWORD_RESET (actor: the customer; no email, no token); an audit outage does not undo or refuse the reset', async () => {
      const email = `pwr-${TAG}@212collectorsclub.test`;
      emails.push(email);
      const customer = await prisma.customer.create({
        data: { email, name: 'Reset Tester', emailVerified: true },
      });
      // The mail carries the token and BetterAuth stores only its hash, so the test plants a
      // one-time token through BetterAuth's own adapter (the same call `forgot-password` makes).
      const tokenOf = async (): Promise<string> => {
        const t = `tok-${TAG}-${randomUUID()}`;
        const ctx = await app.get<CustomerAuth>(CUSTOMER_AUTH).$context;
        await ctx.internalAdapter.createVerificationValue({
          identifier: `reset-password:${t}`,
          value: customer.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        return t;
      };
      const reset = (token: string) =>
        request(server())
          .post(`${BASE}/auth/reset-password`)
          .set('X-Forwarded-For', '198.51.100.77')
          .send({ token, password: 'Nueva-Contrasena-Larga-1234' });

      const since = await head();
      const t1 = await tokenOf();
      await reset(t1).expect(200);
      const rows = await eventsAfter(since, 'CUSTOMER_PASSWORD_RESET');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'CUSTOMER',
        actorId: customer.id,
        entityType: 'Customer',
        entityId: customer.id,
        after: { customerId: customer.id, via: 'EMAIL_TOKEN' },
      });
      expect(JSON.stringify(rows)).not.toContain(t1);
      expect(JSON.stringify(rows)).not.toContain(email);
      // the token is single use: the second try is the same 400 as before and emits nothing
      const again = await reset(t1);
      expect(again.status).toBe(400);
      expect(await eventsAfter(since, 'CUSTOMER_PASSWORD_RESET')).toHaveLength(
        1,
      );

      // audit down: the password HAS changed (BetterAuth uses its own connection), so the answer is
      // still 200 and the failure is logged; nothing is rolled back
      const t2 = await tokenOf();
      const res = await blockAction('CUSTOMER_PASSWORD_RESET', () => reset(t2));
      expect(res.status).toBe(200);
      const login = await request(server())
        .post(`${BASE}/auth/login`)
        .set('X-Forwarded-For', '198.51.100.78')
        .send({ email, password: 'Nueva-Contrasena-Larga-1234' });
      expect(login.status).toBe(200);
    });

    it('admin/customers/verify-email emits CUSTOMER_EMAIL_VERIFIED_BY_ADMIN once per real change (email hashed); fail-closed', async () => {
      process.env.MANUAL_EMAIL_VERIFY_ENABLED = 'true';
      try {
        const email = `vfy-${TAG}@212collectorsclub.test`;
        emails.push(email);
        const c = await prisma.customer.create({
          data: { email, name: 'Verify Tester', emailVerified: false },
        });
        const call = () =>
          request(server())
            .post(`${BASE}/admin/customers/verify-email`)
            .set(auth())
            .send({ email });
        const since = await head();
        const blocked = await blockAction(
          'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN',
          call,
        );
        expect(blocked.status).toBe(503);
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .emailVerified,
        ).toBe(false);
        await call().expect(200);
        await call().expect(200); // already verified: nothing changes, nothing is emitted
        const rows = await eventsAfter(
          since,
          'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actorType: 'ADMIN',
          actorId: adminId,
          entityType: 'Customer',
          entityId: c.id,
          after: { customerId: c.id, adminId },
        });
        expect((rows[0].after as { emailHash: string }).emailHash).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(JSON.stringify(rows)).not.toContain(email);
      } finally {
        delete process.env.MANUAL_EMAIL_VERIFY_ENABLED;
      }
    });

    it('a Stripe payment that cannot be honored emits REFUND_PENDING_RECORDED once (NO_STOCK and AFTER_TERMINAL); a redelivery emits nothing; fail-closed answers 5xx and Stripe redelivers', async () => {
      // 1) paid after the order already failed (expired session): AFTER_TERMINAL
      const p1 = await mkProduct({ price: '10.00' });
      const o1 = await checkout(p1, 'stripe');
      await sendWebhook(
        webhookBody(
          'checkout.session.expired',
          o1.sessionId as string,
          o1.orderId,
          1000,
        ),
      ).expect(200);
      const paid1 = webhookBody(
        'checkout.session.completed',
        o1.sessionId as string,
        o1.orderId,
        1000,
      );
      const since = await head();
      const blocked = await blockAction('REFUND_PENDING_RECORDED', () =>
        sendWebhook(paid1),
      );
      expect(blocked.status).toBeGreaterThanOrEqual(500);
      // nothing half done: the webhook row was rolled back too, so Stripe's retry is processed
      expect(
        await prisma.stripeWebhookEvent.count({
          where: {
            orderId: o1.orderId,
            outcome: { startsWith: 'refund_pending_' },
          },
        }),
      ).toBe(0);
      expect(await eventsAfter(since, 'REFUND_PENDING_RECORDED')).toEqual([]);
      await sendWebhook(paid1).expect(200);
      await sendWebhook(paid1).expect(200); // duplicate
      const r1 = await eventsAfter(since, 'REFUND_PENDING_RECORDED');
      expect(r1).toHaveLength(1);
      expect(r1[0]).toMatchObject({
        actorType: 'SYSTEM',
        entityType: 'Order',
        entityId: o1.orderId,
        after: {
          orderId: o1.orderId,
          reason: 'AFTER_TERMINAL',
          amountUsd: '10',
        },
      });

      // 2) paid but the holds are gone: NO_STOCK (the paid transaction rolls back, a second one records it)
      const p2 = await mkProduct({ price: '10.00', stock: 5 });
      const o2 = await checkout(p2, 'stripe');
      await prisma.$transaction([
        prisma.stockHold.updateMany({
          where: { orderId: o2.orderId },
          data: { releasedAt: new Date() },
        }),
        prisma.product.update({ where: { id: p2 }, data: { heldQty: 0 } }),
      ]);
      const paid2 = webhookBody(
        'checkout.session.completed',
        o2.sessionId as string,
        o2.orderId,
        1000,
      );
      const s2 = await head();
      await sendWebhook(paid2).expect(200);
      await sendWebhook(paid2).expect(200);
      const r2 = await eventsAfter(s2, 'REFUND_PENDING_RECORDED');
      expect(r2).toHaveLength(1);
      expect(r2[0]).toMatchObject({
        entityId: o2.orderId,
        after: { reason: 'NO_STOCK', amountUsd: '10' },
      });
      expect(await eventsAfter(s2, 'STRIPE_PAYMENT_STATE_CHANGED')).toEqual([]);
    });

    it('a TCG sync run closes with ONE DATA_IMPORT_RUN carrying the counters (never a row per price); the actor is the admin who started it, else SYSTEM', async () => {
      const runs = app.get(TcgSyncRunService);
      const row = await runs.tryStart('NIGHTLY');
      expect(row).not.toBeNull();
      const since = await head();
      await runs.finish(row!.id, {
        status: 'PARTIAL',
        requestsUsed: 50,
        cardsSynced: 1200,
        productsUpdated: 37,
        errorCount: 0,
        quotaExhausted: true,
        bigVariations: Array.from({ length: 2 }, (_, i) => ({
          productId: `p${i}`,
          oldPrice: 1,
          newPrice: 2,
          pct: 100,
        })),
      });
      const a = await eventsAfter(since, 'DATA_IMPORT_RUN');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        actorType: 'SYSTEM',
        actorId: null,
        entityType: 'TcgSyncRun',
        entityId: row!.id,
        after: {
          runId: row!.id,
          kind: 'NIGHTLY',
          status: 'PARTIAL',
          requestsUsed: 50,
          cardsSynced: 1200,
          productsUpdated: 37,
          errorCount: 0,
          quotaExhausted: true,
          bigVariations: 2,
        },
      });
      // the run row is the sync LOCK: with the audit log down it is still closed (error logged)
      const row2 = await runs.tryStart('INGEST');
      expect(row2).not.toBeNull();
      const s2 = await head();
      await blockAction('DATA_IMPORT_RUN', () =>
        runs.finish(
          row2!.id,
          {
            status: 'SUCCEEDED',
            requestsUsed: 1,
            cardsSynced: 2,
            errorCount: 0,
            quotaExhausted: false,
          },
          { id: adminId },
        ),
      );
      expect(await eventsAfter(s2, 'DATA_IMPORT_RUN')).toEqual([]);
      const closed = await prisma.tcgSyncRun.findUniqueOrThrow({
        where: { id: row2!.id },
      });
      expect(closed.status).toBe('SUCCEEDED');
      // the missing event leaves a VISIBLE trace in the run row (not a silent null)
      expect(closed.errorSummary).toContain(
        'DATA_IMPORT_RUN event NOT written',
      );
      expect(closed.errorCount).toBe(0);
      // an admin-started run: the actor is that admin
      const row3 = await runs.tryStart('INGEST');
      const s3 = await head();
      await runs.finish(
        row3!.id,
        {
          status: 'SUCCEEDED',
          requestsUsed: 1,
          cardsSynced: 2,
          errorCount: 0,
          quotaExhausted: false,
        },
        { id: adminId },
      );
      const b = await eventsAfter(s3, 'DATA_IMPORT_RUN');
      expect(b[0]).toMatchObject({
        actorType: 'ADMIN',
        actorId: adminId,
        after: { kind: 'INGEST' },
      });
      await prisma.tcgSyncRun.deleteMany({
        where: { id: { in: [row!.id, row2!.id, row3!.id] } },
      });
    });
  });

  // ─── AC5 ────────────────────────────────────────────────────────────────
  describe('AC5: FX and vitrina', () => {
    it('FX settings: a source change emits FX_SOURCE_CHANGED and FX_RATE_CHANGED in one flush, with Fx_Setting_Audits kept', async () => {
      await prisma.$executeRaw`UPDATE "Fx_Rate_Settings" SET "source" = 'BCV_USD'::"FxRateSource", "vesPerUsd" = 100, "rateFetchedAt" = now() WHERE "id" = 'default'`;
      const audits = await prisma.fxSettingAudit.count();
      const since = await head();
      await request(server())
        .put(`${BASE}/admin/fx/settings`)
        .set(auth())
        .send({ source: 'MANUAL', manualVesPerUsd: 365.4 })
        .expect(200);
      const s = await eventsAfter(since, 'FX_SOURCE_CHANGED');
      const r = await eventsAfter(since, 'FX_RATE_CHANGED');
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({
        actorId: adminId,
        before: { source: 'BCV_USD' },
        after: { source: 'MANUAL' },
      });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({
        before: { rate: '100' },
        after: { rate: '365.4', source: 'MANUAL' },
      });
      expect(s[0].seq).toBeLessThan(r[0].seq);
      expect(await prisma.fxSettingAudit.count()).toBe(audits + 1);
      // same rate again: no change, no event
      const again = await head();
      await request(server())
        .put(`${BASE}/admin/fx/settings`)
        .set(auth())
        .send({ source: 'MANUAL', manualVesPerUsd: 365.4 })
        .expect(200);
      expect(await eventsAfter(again)).toEqual([]);
    });

    it('vitrina: only the changed keys are audited (non-integers as strings), VITRINA_CONFIG_CHANGED fail-closed', async () => {
      const cur = (
        await request(server())
          .get(`${BASE}/admin/vitrina/algorithm`)
          .set(auth())
          .expect(200)
      ).body as Record<string, number>;
      const keys = [
        'wSales',
        'wRevenue',
        'wVelocity',
        'wInterest',
        'wNovelty',
        'halfLifeDays',
        'windowDays',
        'noveltyDays',
        'maxPerFranchise',
        'mmrLambda',
        'priorM',
      ];
      const body = Object.fromEntries(keys.map((k) => [k, cur[k]]));
      const next = {
        ...body,
        wSales: cur.wSales + (cur.wRevenue > 0 ? 1 : 0),
        wRevenue: cur.wRevenue > 0 ? cur.wRevenue - 1 : 0,
        mmrLambda: 0.55,
      };
      const since = await head();
      await request(server())
        .put(`${BASE}/admin/vitrina/algorithm`)
        .set(auth())
        .send(next)
        .expect(200);
      const rows = await eventsAfter(since, 'VITRINA_CONFIG_CHANGED');
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0].after as object)).toContain('mmrLambda');
      expect((rows[0].after as Record<string, unknown>).mmrLambda).toBe('0.55');
      expect(Object.keys(rows[0].after as object).length).toBeLessThanOrEqual(
        3,
      );
      const failing = await blockAction('VITRINA_CONFIG_CHANGED', () =>
        request(server())
          .put(`${BASE}/admin/vitrina/algorithm`)
          .set(auth())
          .send({ ...next, mmrLambda: 0.65 }),
      );
      expect(failing.status).toBe(503);
      // restore
      await request(server())
        .put(`${BASE}/admin/vitrina/algorithm`)
        .set(auth())
        .send(body)
        .expect(200);
    });
  });

  // ─── Swagger ────────────────────────────────────────────────────────────
  it('/api/docs-json documents the new answers (503 AUDIT_UNAVAILABLE on every audited write, 429 on the admin login)', async () => {
    const doc = (await request(server()).get('/api/docs-json').expect(200))
      .body as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const audited: [string, string][] = [
      ['/api/v1/admin/auth/login', 'post'],
      ['/api/v1/admin/products', 'post'],
      ['/api/v1/admin/products/{id}', 'delete'],
      ['/api/v1/admin/orders/{orderId}/confirm-payment', 'post'],
      ['/api/v1/admin/orders/{orderId}/reject-payment', 'post'],
      ['/api/v1/admin/orders/{orderId}/fulfill', 'post'],
      ['/api/v1/admin/orders/{orderId}/cancel', 'post'],
      ['/api/v1/admin/orders/{orderId}/tracking', 'patch'],
      ['/api/v1/admin/products/{id}', 'patch'],
      ['/api/v1/admin/products/{id}/stock', 'patch'],
      ['/api/v1/admin/shipping/agencies', 'post'],
      ['/api/v1/admin/shipping/agencies/{id}', 'patch'],
      ['/api/v1/admin/shipping/agencies/{id}', 'delete'],
      ['/api/v1/admin/fx/settings', 'put'],
      ['/api/v1/admin/fx/accept-rejected', 'post'],
      ['/api/v1/admin/vitrina/algorithm', 'put'],
      ['/api/v1/admin/legal/identity', 'put'],
      ['/api/v1/admin/legal/{slug}/publish', 'post'],
      ['/api/v1/checkout', 'post'],
      ['/api/v1/auth/register', 'post'],
      ['/api/v1/me/consent', 'post'],
      ['/api/v1/payments/stripe/webhook', 'post'],
    ];
    for (const [path, method] of audited) {
      const r = doc.paths[path]?.[method]?.responses?.['503'];
      expect({ path, method, has503: r !== undefined }).toMatchObject({
        has503: true,
      });
      expect(r?.description).toContain('AUDIT_UNAVAILABLE');
    }
    expect(
      doc.paths['/api/v1/admin/auth/login'].post.responses['429'].description,
    ).toContain('ADMIN_LOGIN_RATE_LIMITED');
  });

  // ─── AC7 ────────────────────────────────────────────────────────────────
  it('AC7: DATA_EXPORTED is wired in AuditService as a helper (nothing exports data yet) and REFUND_ISSUED is documented as pending', async () => {
    const { AuditService } = await import('./../src/audit/audit.service.js');
    const since = await head();
    await app.get(AuditService).recordDataExport(
      { id: adminId },
      {
        dataset: 'orders',
        format: 'csv',
        rows: 3,
        filters: { status: 'PAID' },
      },
    );
    const rows = await eventsAfter(since, 'DATA_EXPORTED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: adminId,
      entityType: 'Export',
      after: {
        dataset: 'orders',
        format: 'csv',
        rows: 3,
        filters: { status: 'PAID' },
      },
    });
  });

  // ─── AC8 ────────────────────────────────────────────────────────────────
  describe('AC8: concurrency, crossings, chain, PII', () => {
    it('20 simultaneous Pago Movil confirmations: no 5xx, every event present, linear chain', async () => {
      const p = await mkProduct({ stock: 100 });
      const orders = [];
      for (let i = 0; i < 20; i++) orders.push(await checkout(p));
      const since = await head();
      const t0 = performance.now();
      const res = await Promise.all(orders.map((o) => confirm(o.orderId)));
      const ms = performance.now() - t0;
      console.log(
        `[20.5 concurrency] 20 simultaneous confirmations took ${ms.toFixed(0)} ms`,
      );
      expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
      const rows = await eventsAfter(since, 'PAYMENT_PAGO_MOVIL_CONFIRMED');
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((r) => r.entityId)).size).toBe(20);
      const seqs = (await eventsAfter(since)).map((r) => r.seq);
      expect(seqs).toEqual(seqs.map((_, i) => since + 1 + i));
      const v = await new AuditChainVerifier().verify(
        (q, params = []) =>
          prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...params),
        { mode: 'full' },
      );
      expect(v).toMatchObject({ ok: true, done: true });
    });

    it('crossings: confirmations, fulfilments, FX and vitrina writes, price/stock edits, webhooks, logins and checkouts at once => no 5xx, no deadlock, chain intact', async () => {
      const p = await mkProduct({ stock: 200 });
      const pagos = [];
      const stripes = [];
      for (let i = 0; i < 6; i++) pagos.push(await checkout(p));
      for (let i = 0; i < 4; i++) stripes.push(await checkout(p, 'stripe'));
      const paid = [];
      for (let i = 0; i < 4; i++) {
        const o = await checkout(p);
        await confirm(o.orderId).expect(200);
        paid.push(o);
      }
      const carts = [];
      for (let i = 0; i < 4; i++) {
        carts.push(
          cookieOf(
            await request(server())
              .post(`${BASE}/cart/items`)
              .send({ productId: p, quantity: 1 })
              .expect(201),
            'cartId',
          ),
        );
      }
      const since = await head();
      const ops: Promise<{ status: number }>[] = [
        ...pagos.slice(0, 3).map((o) => confirm(o.orderId)),
        ...pagos.slice(3).map((o) => reject(o.orderId)),
        ...paid
          .slice(0, 2)
          .map((o) =>
            request(server())
              .post(`${BASE}/admin/orders/${o.orderId}/fulfill`)
              .set(auth()),
          ),
        ...paid
          .slice(2)
          .map((o) =>
            request(server())
              .post(`${BASE}/admin/orders/${o.orderId}/cancel`)
              .set(auth()),
          ),
        ...stripes.map((o) =>
          sendWebhook(
            webhookBody(
              'checkout.session.completed',
              o.sessionId as string,
              o.orderId,
              1000,
            ),
          ),
        ),
        ...paid.map((o) =>
          request(server())
            .patch(`${BASE}/admin/orders/${o.orderId}/tracking`)
            .set(auth())
            .send({ trackingNumber: `TRK${randomUUID().slice(0, 8)}` }),
        ),
        request(server())
          .put(`${BASE}/admin/fx/settings`)
          .set(auth())
          .send({ source: 'MANUAL', manualVesPerUsd: 400.25 }),
        request(server())
          .patch(`${BASE}/admin/products/${p}`)
          .set(auth())
          .send({ priceUsd: 11.11 }),
        request(server())
          .patch(`${BASE}/admin/products/${p}/stock`)
          .set(auth())
          .send({ stock: 150 }),
        request(server())
          .post(`${BASE}/admin/auth/login`)
          .send({ usernameOrEmail: ADMIN_USER, password: PASS }),
        ...carts.map((cart) =>
          request(server())
            .post(`${BASE}/checkout`)
            .set('Cookie', cart)
            .send(
              withBuyerId({
                paymentRail: 'pago_movil',
                fulfillmentType: 'delivery',
                addressLine1: S_ADDRESS,
                city: 'Caracas',
                state: 'Distrito Capital',
                recipientName: S_NAME,
                recipientPhone: S_PHONE,
              }),
            ),
        ),
      ];
      const t0 = performance.now();
      const res = await Promise.all(ops);
      const ms = performance.now() - t0;
      console.log(
        `[20.5 crossings] ${ops.length} mixed concurrent operations took ${ms.toFixed(0)} ms`,
      );
      const bad = res.filter((r) => r.status >= 500);
      expect(bad.map((r) => r.status)).toEqual([]);
      const evs = await eventsAfter(since);
      const seqs = evs.map((r) => r.seq);
      expect(seqs).toEqual(seqs.map((_, i) => since + 1 + i));
      const v = await new AuditChainVerifier().verify(
        (q, params = []) =>
          prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...params),
        { mode: 'full' },
      );
      expect(v).toMatchObject({ ok: true, done: true });
      const actions = new Set(evs.map((e) => e.action));
      for (const a of [
        'PAYMENT_PAGO_MOVIL_CONFIRMED',
        'PAYMENT_PAGO_MOVIL_REJECTED',
        'ORDER_STATUS_CHANGED',
        'STRIPE_PAYMENT_STATE_CHANGED',
        'ORDER_TRACKING_CHANGED',
        'PRODUCT_PRICE_CHANGED',
        'LOGIN_ADMIN_OK',
        'CONSENT_RECORDED',
      ]) {
        if (a === 'CONSENT_RECORDED') continue; // no consent document in force in this scenario
        expect(actions.has(a)).toBe(true);
      }
    });
  });

  // ─── AC6 ────────────────────────────────────────────────────────────────
  describe('AC6: legal and consent', () => {
    const doc: { id?: string; slug?: string } = {};
    let seeded: SeededConsent;
    let identityBefore: string;
    const consentOrderIds: string[] = [];

    beforeAll(async () => {
      const d = await createSandboxDocument(sql, `emit${TAG}`);
      doc.id = d.id;
      doc.slug = d.slug;
      // Seller_Identity_Settings is a mutable singleton: the identity scenario below changes it
      // and afterAll puts it back (the Legal_Audit_Logs row it leaves is append-only and carries
      // this run's own admin id, so no other suite depends on it).
      identityBefore = JSON.stringify(
        (
          await sql(
            `SELECT "legalName","rif","fiscalAddress","contactEmail","phone","updatedById"::text AS "updatedById"
               FROM "Seller_Identity_Settings" WHERE "id" = 'default'`,
          )
        )[0],
      );
      seeded = await seedConsentDocs(sql, {
        terms: [{ versionNumber: 1 }],
        privacy: [{ versionNumber: 1 }],
        shipping: [{ versionNumber: 1 }],
        returns: [{ versionNumber: 1 }],
      });
    });
    afterAll(async () => {
      const idb = JSON.parse(identityBefore) as Record<string, string | null>;
      await sql(
        `UPDATE "Seller_Identity_Settings"
            SET "legalName" = $1, "rif" = $2, "fiscalAddress" = $3, "contactEmail" = $4,
                "phone" = $5, "updatedById" = $6::uuid
          WHERE "id" = 'default'`,
        [
          idb.legalName,
          idb.rif,
          idb.fiscalAddress,
          idb.contactEmail,
          idb.phone,
          idb.updatedById,
        ],
      ).catch(() => undefined);
      // Acceptance evidence is append-only: release it (delete its orders / customers) so the
      // sandbox documents can go and later checkouts are not asked for consent versions.
      await prisma.order
        .deleteMany({ where: { id: { in: consentOrderIds } } })
        .catch(() => undefined);
      await prisma.customer
        .deleteMany({ where: { email: { in: emails } } })
        .catch(() => undefined);
      await seeded.cleanup().catch(() => undefined);
      await purgeSandbox(sql, `emit${TAG}`).catch(() => undefined);
    });

    it('publishing emits LEGAL_DOC_PUBLISHED (hash, never the text); DRAFT_EDITED and other drafts actions emit nothing', async () => {
      const since = await head();
      const body = `## Uso\n\nTexto secreto del documento ${TAG}.`;
      await request(server())
        .put(`${BASE}/admin/legal/${doc.slug}/draft`)
        .set(auth())
        .send({ bodyMd: body, baseRevision: 0 })
        .expect(200);
      await request(server())
        .put(`${BASE}/admin/legal/${doc.slug}/draft`)
        .set(auth())
        .send({ bodyMd: body + ' mas', baseRevision: 1 })
        .expect(200);
      const draft = (
        await request(server())
          .get(`${BASE}/admin/legal/${doc.slug}/draft`)
          .set(auth())
          .expect(200)
      ).body as { revision: number };
      expect(await eventsAfter(since)).toEqual([]);
      await request(server())
        .post(`${BASE}/admin/legal/${doc.slug}/publish`)
        .set(auth())
        .send({
          changeSummary: 'primera version',
          isSubstantial: false,
          expectedRevision: draft.revision,
          effectiveFrom: new Date(
            ((await sql(`SELECT now() AS n`))[0].n as Date).getTime() + 1_500,
          ).toISOString(),
        })
        .expect(201);
      const rows = await eventsAfter(since, 'LEGAL_DOC_PUBLISHED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: adminId,
        entityType: 'LegalDocument',
        entityId: doc.id,
        after: { documentId: doc.id, slug: doc.slug, version: 1 },
      });
      expect((rows[0].after as { contentHash: string }).contentHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(JSON.stringify(rows)).not.toContain('secreto');
      expect(
        Number(
          (
            await sql(
              `SELECT count(*)::int AS n FROM "Legal_Audit_Logs" WHERE "documentId" = $1::uuid AND "action" = 'PUBLISHED'`,
              [doc.id],
            )
          )[0].n,
        ),
      ).toBe(1);
    });

    it('seller identity: SELLER_IDENTITY_UPDATED carries the changed public fields; no change, no event', async () => {
      const since = await head();
      await request(server())
        .put(`${BASE}/admin/legal/identity`)
        .set(auth())
        .send({
          legalName: `Colecciones ${TAG} C.A.`,
          rif: 'J-12345678-9',
          contactEmail: 'ventas@212collectorsclub.test',
        })
        .expect(200);
      await request(server())
        .put(`${BASE}/admin/legal/identity`)
        .set(auth())
        .send({ legalName: `Colecciones ${TAG} C.A.` })
        .expect(200);
      const rows = await eventsAfter(since, 'SELLER_IDENTITY_UPDATED');
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe('default');
      expect(rows[0].after).toMatchObject({
        legalName: `Colecciones ${TAG} C.A.`,
        rif: 'J-12345678-9',
        contactEmail: 'ventas@212collectorsclub.test',
      });
    });

    it('a checkout with 3 consents emits ONE CONSENT_RECORDED with the 3 row ids and versions', async () => {
      const p = await mkProduct();
      const since = await head();
      const o = await checkout(p, 'pago_movil', seeded.checkoutBody());
      consentOrderIds.push(o.orderId);
      const rows = await eventsAfter(since, 'CONSENT_RECORDED');
      expect(rows).toHaveLength(1);
      const ids = (rows[0].after as { consentRecordIds: string[] })
        .consentRecordIds;
      expect(ids).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        actorType: 'ANON',
        entityType: 'Order',
        entityId: o.orderId,
        after: {
          context: 'CHECKOUT',
          versions: { TERMS: 1, SHIPPING: 1, RETURNS: 1 },
        },
      });
      const stored = await sql(
        `SELECT "id"::text AS id FROM "Consent_Records" WHERE "orderId" = $1::uuid`,
        [o.orderId],
      );
      expect(stored.map((r) => r.id).sort()).toEqual([...ids].sort());
    });

    it('register emits one CONSENT_RECORDED; an audit failure leaves NO orphan account (503) and the same email can register afterwards', async () => {
      const email = `reg-${TAG}@212collectorsclub.test`;
      emails.push(email);
      const body = {
        email,
        password: 'Contrasena-Larga-1234',
        name: 'Cns Tester',
        ...seeded.registerBody(),
      };
      const failed = await blockAction('CONSENT_RECORDED', () =>
        request(server()).post(`${BASE}/auth/register`).send(body),
      );
      expect(failed.status).toBe(503);
      expect((failed.body as { errorCode: string }).errorCode).toBe(
        'AUDIT_UNAVAILABLE',
      );
      expect(await prisma.customer.count({ where: { email } })).toBe(0);
      const since = await head();
      await request(server())
        .post(`${BASE}/auth/register`)
        .send(body)
        .expect(201);
      const c = await prisma.customer.findUniqueOrThrow({ where: { email } });
      const rows = await eventsAfter(since, 'CONSENT_RECORDED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'CUSTOMER',
        actorId: c.id,
        entityType: 'Customer',
        after: { context: 'REGISTER', customerId: c.id },
      });
      expect(
        (rows[0].after as { consentRecordIds: string[] }).consentRecordIds,
      ).toHaveLength(3);
    });

    it('re-accept: a concurrent double click records once and emits one event', async () => {
      const email = `rea-${TAG}@212collectorsclub.test`;
      emails.push(email);
      await request(server())
        .post(`${BASE}/auth/register`)
        .send({
          email,
          password: 'Contrasena-Larga-1234',
          name: 'Cns Tester',
          ...seeded.registerBody(),
        })
        .expect(201);
      await prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      const login = await request(server())
        .post(`${BASE}/auth/login`)
        .send({ email, password: 'Contrasena-Larga-1234' })
        .expect(200);
      const cookie = cookieOf(login, 'cc_session');
      await seeded.addVersion('terms', {
        versionNumber: 2,
        effectiveFrom: '-1 minute',
        isSubstantial: true,
        changeSummary: 'nueva clausula',
      });
      const since = await head();
      const rs = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(server())
            .post(`${BASE}/me/consent`)
            .set('Cookie', cookie)
            .send({ acceptedTermsVersion: 2 }),
        ),
      );
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const rows = await eventsAfter(since, 'CONSENT_RECORDED');
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        context: 'RE_ACCEPT',
        versions: { TERMS: 2 },
      });
    });
  });

  // ─── AC8 (sweep over everything emitted by the run, after all scenarios) ──
  describe('AC8: PII sweep and catalog coverage by real events', () => {
    it('PII sweep: no email, phone, address, name or cedula (sentinels) in ANY event emitted by this run; every payload re-passes the strict guard', async () => {
      await checkout(await mkProduct(), 'pago_movil', {
        buyerId: { type: 'V', number: S_CEDULA_DIGITS },
        recipientIdDoc: S_CEDULA,
      });
      const all = await eventsAfter(startSeq.v);
      expect(all.length).toBeGreaterThan(40);
      const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
      const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
      const CEDULA = /\b[VEJGP]-?\d{7,9}\b/i;
      for (const e of all) {
        // The seller's own public identity is the one allowed exception (catalog publicFields).
        if (e.action === 'SELLER_IDENTITY_UPDATED') continue;
        const text = JSON.stringify([e.before, e.after, e.reason]);
        for (const s of [
          S_CEDULA,
          S_CEDULA_DIGITS,
          S_PHONE,
          S_ADDRESS,
          S_NAME,
          S_EMAIL,
        ]) {
          expect({
            seq: e.seq,
            action: e.action,
            leaks: text.includes(s),
          }).toMatchObject({ leaks: false });
        }
        expect({
          seq: e.seq,
          action: e.action,
          email: EMAIL.test(text),
        }).toMatchObject({ email: false });
        // Ids are not documents: the first group of a random uuid is 8 hex characters and, when it
        // starts with `e` and the other seven are digits (`e8025369-...`), it is a cedula to the
        // regex below (about 0.2 % of the uuids: a run with ~150 uuids in its events failed 1 time in
        // 5). So uuids, long hex (hashes) and dates are removed BEFORE the cedula and phone scans;
        // the exact sentinels above are still searched in the whole text.
        const stripped = text
          .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            '',
          )
          .replace(/[0-9a-f]{32,}/gi, '')
          .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, '');
        expect({
          seq: e.seq,
          action: e.action,
          cedula: CEDULA.exec(stripped)?.[0] ?? false,
        }).toMatchObject({ cedula: false });
        // phones: the free-form regex may match long ids (uuid digits); only flag digit runs outside hex ids
        expect({
          seq: e.seq,
          action: e.action,
          phone: PHONE.test(stripped),
        }).toMatchObject({ phone: false });
        // the strict guard accepts what the emitters wrote
        for (const side of [e.before, e.after]) {
          if (side === null) continue;
          expect(() =>
            sanitizeAuditPayload(
              side,
              'strict',
              '$',
              publicFieldsOf(e.action as AuditAction),
            ),
          ).not.toThrow();
        }
      }
    });

    it('catalog coverage by REAL events: every 20.5 action that can be emitted today was emitted in this run', async () => {
      const seen = new Set(
        (await eventsAfter(startSeq.v)).map((e) => e.action),
      );
      const pending = new Set<string>([
        'REFUND_ISSUED',
        'ADMIN_CREDENTIALS_CHANGED',
        'ADMIN_ROLE_CHANGED',
        'ADMIN_CREATED',
        'ADMIN_DISABLED',
      ]);
      const missing = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
        (a) =>
          AUDIT_ACTIONS[a].emittedBy === '20.5' &&
          !pending.has(a) &&
          !seen.has(a),
      );
      expect(missing).toEqual([]);
    });
  });
});
