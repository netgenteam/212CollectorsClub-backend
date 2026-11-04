import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AuditService } from './../src/audit/audit.service.js';
import { STRIPE_CLIENT } from './../src/payments-stripe/stripe-client.interface.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';
import { FakeStripeClient } from './../src/payments-stripe/fake-stripe-client.js';
import { withBuyerId } from './helpers/buyer-id.js';
import { snapshotFx, restoreFx } from './helpers/db-snapshot.js';
import {
  seedConsentDocs,
  type SeededConsent,
} from './helpers/legal-consent.js';

/**
 * Story 20.5: what the audit emission COSTS on the hot routes, measured on the real stack.
 *
 * "Before" = the same code with `AuditService` replaced by a pass-through that opens the very same
 * transaction and flushes nothing (no event, no chain lock); "after" = the real service. The two
 * apps share the throw-away database and are measured interleaved (3 rounds) so drift hits both.
 * Numbers are printed (console) and asserted only against generous ceilings: this is a
 * measurement, not a benchmark gate.
 *
 * Plus the rule that matters most (AD-99 "using it safely"): no slow external call may hold the
 * chain lock. Checkout with Stripe (a 300 ms call) at 8/s must not queue behind the chain.
 */
const TAG = randomUUID().slice(0, 8);
const PASS = 'correct-horse-battery-staple-20-5p';
const BASE = '/api/v1';

type Samples = number[];
const pct = (xs: Samples, p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: Samples): string =>
  `p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms (n=${xs.length})`;

interface Ctx {
  app: NestExpressApplication;
  prisma: PrismaService;
  token: string;
  adminId: string;
}
const results: Record<string, { off: Samples; on: Samples }> = {};

async function build(passThrough: boolean, stripeDelayMs = 0): Promise<Ctx> {
  let b = Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true });
  if (passThrough) {
    b = b.overrideProvider(AuditService).useFactory({
      factory: (prisma: PrismaService) => ({
        transaction: <T>(
          fn: (tx: unknown, a: { add: () => void }) => Promise<T>,
          o: { maxWait?: number; timeout?: number } = {},
        ) =>
          prisma.$transaction((tx) => fn(tx, { add: () => undefined }), {
            maxWait: o.maxWait ?? 10_000,
            timeout: o.timeout ?? 30_000,
          }),
        record: () => Promise.resolve({ seq: 0, hash: '' }),
        recordDataExport: () => Promise.resolve(),
      }),
      inject: [PrismaService],
    });
  }
  if (stripeDelayMs > 0) {
    b = b.overrideProvider(STRIPE_CLIENT).useValue(
      new (class extends FakeStripeClient {
        override async createCheckoutSession(
          ...a: Parameters<FakeStripeClient['createCheckoutSession']>
        ) {
          await new Promise((r) => setTimeout(r, stripeDelayMs));
          return super.createCheckoutSession(...a);
        }
      })({ get: () => undefined } as unknown as ConfigService),
    );
  }
  const moduleRef = await b.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
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
  const prisma = app.get(PrismaService);
  const user = `perf-${TAG}-${passThrough ? 'off' : 'on'}-${stripeDelayMs}`;
  const admin = await prisma.adminUser.create({
    data: {
      username: user,
      email: `${user}@212collectorsclub.test`,
      passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
    },
  });
  const login = await request(url(app))
    .post(`${BASE}/admin/auth/login`)
    .send({ usernameOrEmail: user, password: PASS })
    .expect(200);
  return {
    app,
    prisma,
    adminId: admin.id,
    token: (login.body as { accessToken: string }).accessToken,
  };
}
const url = (app: NestExpressApplication): string =>
  `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

describe(
  'audit emission cost (Story 20.5, measured)',
  { timeout: 300_000 },
  () => {
    let off: Ctx;
    let on: Ctx;
    let categoryId: string;
    const productIds: string[] = [];
    let savedFx: Awaited<ReturnType<typeof snapshotFx>>;
    const rec = (name: string, which: 'off' | 'on', xs: Samples) => {
      (results[name] ??= { off: [], on: [] })[which].push(...xs);
    };

    async function mkProduct(stock = 5000): Promise<string> {
      const p = await on.prisma.product.create({
        data: {
          name: `Perf${TAG} ${productIds.length}`,
          slug: `perf${TAG}-${productIds.length}`,
          description: 'Created by perf 20.5.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '10.00',
          stock,
          heldQty: 0,
          isActive: true,
          categoryId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }
    const cookieOf = (res: request.Response): string =>
      (res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('cartId='))!
        .split(';')[0];

    let consent: SeededConsent | null = null;

    async function checkoutOn(
      c: Ctx,

      productId: string,

      rail: 'pago_movil' | 'stripe' = 'pago_movil',

      withConsent = true,
    ): Promise<{ orderId: string; sessionId?: string; ms: number }> {
      const cart = cookieOf(
        await request(url(c.app))
          .post(`${BASE}/cart/items`)
          .send({ productId, quantity: 1 })
          .expect(201),
      );
      const t0 = performance.now();
      const res = await request(url(c.app))
        .post(`${BASE}/checkout`)
        .set('Cookie', cart)
        .send(
          withBuyerId({
            paymentRail: rail,
            fulfillmentType: 'delivery',
            addressLine1: 'Av. Perf 1',
            city: 'Caracas',
            state: 'Distrito Capital',
            recipientName: 'Perf Tester',
            recipientPhone: '0412-1234567',
            ...(withConsent && consent ? consent.checkoutBody() : {}),
          }),
        );
      const ms = performance.now() - t0;
      expect([res.status, res.text.slice(0, 300)]).toEqual([
        201,
        res.text.slice(0, 300),
      ]);
      const body = res.body as {
        orderId: string;
        stripe?: { sessionId: string };
      };
      return { orderId: body.orderId, sessionId: body.stripe?.sessionId, ms };
    }

    beforeAll(async () => {
      // the consent documents resolve to the SANDBOX slugs (never a real, immutable document)
      process.env.LEGAL_CONSENT_SLUG_PREFIX = 'e2e-';
      process.env.NODE_ENV = 'test';
      off = await build(true);
      on = await build(false);
      categoryId = (await on.prisma.category.findFirstOrThrow()).id;
      savedFx = await snapshotFx(on.prisma);
      consent = await seedConsentDocs(
        (q, p = []) =>
          on.prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p),
        {
          terms: [{ versionNumber: 1 }],
          shipping: [{ versionNumber: 1 }],
          returns: [{ versionNumber: 1 }],
        },
      );
      // the copied FX row can be weeks old (checkout answers 503 when stale)
      await on.prisma
        .$executeRaw`UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = now() WHERE "id" = 'default'`;
    });
    afterAll(async () => {
      await restoreFx(on.prisma, savedFx).catch(() => undefined);
      for (const c of [off, on]) {
        await c.prisma.order
          .deleteMany({
            where: { lines: { some: { productId: { in: productIds } } } },
          })
          .catch(() => undefined);
        await c.prisma.adminUser
          .delete({ where: { id: c.adminId } })
          .catch(() => undefined);
      }
      await on.prisma.product
        .deleteMany({ where: { id: { in: productIds } } })
        .catch(() => undefined);
      await off.app.close();
      await on.app.close();
      console.log(
        '\n[20.5 cost] route | before (no audit) | after (audit) | delta p50',
      );
      for (const [name, r] of Object.entries(results)) {
        console.log(
          `[20.5 cost] ${name} | ${fmt(r.off)} | ${fmt(r.on)} | ${(pct(r.on, 50) - pct(r.off, 50)).toFixed(1)} ms`,
        );
      }
    });

    it('checkout (Pago Movil), sequential and 8 concurrent; confirm; webhook; FX PUT; vitrina PUT', async () => {
      const pid = await mkProduct();
      for (let round = 0; round < 3; round++) {
        for (const [which, c] of [
          ['off', off],
          ['on', on],
        ] as const) {
          // checkout sequential
          const seq: Samples = [];
          const orders: string[] = [];
          for (let i = 0; i < 10; i++) {
            const r = await checkoutOn(c, pid);
            seq.push(r.ms);
            orders.push(r.orderId);
          }
          rec(
            'checkout pago_movil + 3 consents -> 1 event (sequential)',
            which,
            seq,
          );

          // checkout concurrent (8 at once, 2 waves)
          const conc: Samples = [];
          for (let w = 0; w < 2; w++) {
            const wave = await Promise.all(
              Array.from({ length: 8 }, () => checkoutOn(c, pid)),
            );
            conc.push(...wave.map((x) => x.ms));
            orders.push(...wave.map((x) => x.orderId));
          }
          rec(
            'checkout pago_movil + 3 consents -> 1 event (8 concurrent)',
            which,
            conc,
          );

          // confirm (sequential)
          const conf: Samples = [];
          for (const o of orders.slice(0, 10)) {
            const t0 = performance.now();
            await request(url(c.app))
              .post(`${BASE}/admin/orders/${o}/confirm-payment`)
              .set('Authorization', `Bearer ${c.token}`)
              .expect(200);
            conf.push(performance.now() - t0);
          }
          rec('confirm-payment (sequential)', which, conf);

          // webhook (stripe) sequential
          const hook: Samples = [];
          for (let i = 0; i < 8; i++) {
            const o = await checkoutOn(c, pid, 'stripe');
            const payload = JSON.stringify({
              id: `evt_${TAG}_${randomUUID()}`,
              object: 'event',
              type: 'checkout.session.completed',
              data: {
                object: {
                  object: 'checkout.session',
                  id: o.sessionId,
                  client_reference_id: o.orderId,
                  metadata: { orderId: o.orderId },
                  payment_status: 'paid',
                  amount_total: 1000,
                  currency: 'usd',
                  payment_intent: 'pi_perf',
                },
              },
            });
            const t0 = performance.now();
            await request(url(c.app))
              .post(`${BASE}/payments/stripe/webhook`)
              .set('Content-Type', 'application/json')
              .set(
                'Stripe-Signature',
                Stripe.webhooks.generateTestHeaderString({
                  payload,
                  secret: FAKE_STRIPE_WEBHOOK_SECRET,
                }),
              )
              .send(payload)
              .expect(200);
            hook.push(performance.now() - t0);
          }
          rec('stripe webhook paid (sequential)', which, hook);

          // FX PUT
          const fx: Samples = [];
          for (let i = 0; i < 6; i++) {
            const t0 = performance.now();
            await request(url(c.app))
              .put(`${BASE}/admin/fx/settings`)
              .set('Authorization', `Bearer ${c.token}`)
              .send({
                source: 'MANUAL',
                manualVesPerUsd:
                  300 + i + round * 10 + (which === 'on' ? 0.5 : 0),
              })
              .expect(200);
            fx.push(performance.now() - t0);
          }
          rec('PUT /admin/fx/settings (manual)', which, fx);

          // vitrina PUT
          const cur = (
            await request(url(c.app))
              .get(`${BASE}/admin/vitrina/algorithm`)
              .set('Authorization', `Bearer ${c.token}`)
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
          const vit: Samples = [];
          for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            await request(url(c.app))
              .put(`${BASE}/admin/vitrina/algorithm`)
              .set('Authorization', `Bearer ${c.token}`)
              .send({ ...body, mmrLambda: i % 2 === 0 ? 0.55 : 0.65 })
              .expect(200);
            vit.push(performance.now() - t0);
          }
          rec('PUT /admin/vitrina/algorithm', which, vit);
          await request(url(c.app))
            .put(`${BASE}/admin/vitrina/algorithm`)
            .set('Authorization', `Bearer ${c.token}`)
            .send(body)
            .expect(200);
        }
      }
      // generous ceilings: a regression of orders of magnitude fails, noise does not
      for (const [name, r] of Object.entries(results)) {
        expect({
          name,
          ok: pct(r.on, 50) < pct(r.off, 50) + 150,
        }).toMatchObject({ ok: true });
      }
    });

    it('a 300 ms Stripe call at 8 checkouts/s does not queue behind the chain lock (the AD-99 rule, measured)', async () => {
      const slow = await build(false, 300);
      try {
        const pid = await mkProduct();
        const lat: Samples = [];
        const t0 = performance.now();
        const pending: Promise<void>[] = [];
        // 8 per second for 6 s, each a real Stripe-rail checkout (300 ms outside the transaction)
        for (let sec = 0; sec < 6; sec++) {
          for (let i = 0; i < 8; i++) {
            pending.push(
              checkoutOn(slow, pid, 'stripe').then((r) => {
                lat.push(r.ms);
              }),
            );
            await new Promise((r) => setTimeout(r, 125));
          }
        }
        await Promise.all(pending);
        const wall = performance.now() - t0;
        console.log(
          `[20.5 stripe-300ms] 48 stripe checkouts at 8/s: ${fmt(lat)}, wall ${wall.toFixed(0)} ms`,
        );
        // measured before the fix design: p50 7.5 s with the call after record(); here ~300 ms + base
        expect(pct(lat, 50)).toBeLessThan(1_000);
        expect(pct(lat, 95)).toBeLessThan(3_000);
        await slow.prisma.adminUser
          .delete({ where: { id: slow.adminId } })
          .catch(() => undefined);
      } finally {
        await slow.app.close();
      }
    });
  },
);
