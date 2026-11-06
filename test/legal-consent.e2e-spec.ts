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
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  purgeConsentDocs,
  seedConsentDocs,
  type SeededConsent,
} from './helpers/legal-consent.js';
import { withBuyerId } from './helpers/buyer-id.js';

/**
 * Story 19.4 (AD-92, FR-112..116): consent in register / checkout /
 * re-accept, immutability of `Consent_Records` and the admin read side.
 *
 * Documents: ONLY sandbox ones (`e2e-terminos`, `e2e-privacidad`,
 * `e2e-envios`, `e2e-devoluciones`; `vitest.config.e2e.ts` points the app's
 * consent lookup at them), so no real, immutable document is ever published.
 * Real documents are never touched. Zero network (fake FX/Stripe).
 */
const PASSWORD = 'correct-horse-battery-19-4';
const TAG = randomUUID().slice(0, 8);
const emailOf = (k: string) => `e2e-19-4-${TAG}-${k}@212collectorsclub.test`;
const ADMIN_USERNAME = `e2e-admin-19-4-${TAG}`;
const ADMIN_PASSWORD = 'correct-horse-battery-staple-19-4';

interface Err {
  statusCode?: number;
  errorCode?: string;
  details?: {
    missing?: string[];
    current?: Record<string, number>;
    stale?: string[];
    documents?: string[];
  };
}
interface Checkout {
  orderId: string;
  orderAccessToken: string;
}
interface Consent {
  id: string;
  type: string;
  version: number;
  documentVersionId: string | null;
  context: string;
  acceptedAt: string;
  customerId: string | null;
  orderId: string | null;
}

const checkoutBody = (over: Record<string, unknown> = {}) => ({
  paymentRail: 'pago_movil',
  fulfillmentType: 'delivery',
  addressLine1: 'Av. Test 1',
  city: 'Caracas',
  state: 'Distrito Capital',
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
  ...over,
});

describe(
  'Consent records, register, checkout, re-accept (Story 19.4, e2e)',
  {
    timeout: 60_000,
  },
  () => {
    let app: NestExpressApplication;
    let prisma: PrismaService;
    let seeded: SeededConsent;
    let adminToken: string;
    let adminId: string;
    let categoryId: string;
    const productIds: string[] = [];
    const emails: string[] = [];
    const server = () => app.getHttpServer() as Parameters<typeof request>[0];
    const sql = (q: string, p: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

    const mkProduct = async (key: string, stock = 50): Promise<string> => {
      const p = await prisma.product.create({
        data: {
          name: `Cns${TAG} ${key}`,
          slug: `cns${TAG}-${key}`.toLowerCase(),
          description: 'Created by e2e 19.4.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '5.00',
          stock,
          heldQty: 0,
          isActive: true,
          categoryId,
        },
      });
      productIds.push(p.id);
      return p.id;
    };

    const cookieOf = (res: request.Response, name: string): string =>
      ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0] as string;

    const guestCart = async (productId: string, quantity = 1) =>
      cookieOf(
        await request(server())
          .post('/api/v1/cart/items')
          .send({ productId, quantity })
          .expect(201),
        'cartId',
      );

    const register = (
      email: string,
      extra: Record<string, unknown> = seeded.registerBody(),
    ) =>
      request(server())
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, name: 'Cns Tester', ...extra });

    async function customer(k: string, extra?: Record<string, unknown>) {
      const email = emailOf(k);
      emails.push(email);
      await register(email, extra).expect(201);
      const c = await prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      const res = await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return { email, id: c.id, s: cookieOf(res, 'cc_session') };
    }

    const consentsOf = async (where: {
      customerId?: string;
      orderId?: string;
    }): Promise<Consent[]> => {
      const res = await request(server())
        .get('/api/v1/admin/legal/consents')
        .query(where)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return (res.body as { consents: Consent[] }).consents;
    };

    const counts = async () => {
      const [o] = await sql(
        `SELECT count(*)::int AS n FROM "Orders" o WHERE EXISTS (SELECT 1 FROM "Order_Lines" l WHERE l."orderId" = o."id" AND l."productId" = ANY($1::uuid[]))`,
        [productIds],
      );
      const [h] = await sql(
        `SELECT count(*)::int AS n FROM "Stock_Holds" WHERE "productId" = ANY($1::uuid[])`,
        [productIds],
      );
      const [c] = await sql(`SELECT count(*)::int AS n FROM "Consent_Records"`);
      const [cu] = await sql(
        `SELECT count(*)::int AS n FROM "Customers" WHERE "email" LIKE $1`,
        [`e2e-19-4-${TAG}-%`],
      );
      return {
        orders: o.n as number,
        holds: h.n as number,
        consents: c.n as number,
        customers: cu.n as number,
      };
    };

    /** Standard timeline: terms 1(-3d) 2(-2d, substantial) 3(-1d); privacy/shipping/returns 1. */
    const seedAll = () =>
      seedConsentDocs(sql, {
        terms: [
          { versionNumber: 1, effectiveFrom: '-3 days' },
          { versionNumber: 2, effectiveFrom: '-2 days', isSubstantial: true },
          { versionNumber: 3, effectiveFrom: '-1 day' },
        ],
        privacy: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
        shipping: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
        returns: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
      });

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleFixture.createNestApplication<NestExpressApplication>();
      app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
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
      // ONE shared listening server: the concurrent rounds below must not open
      // an ephemeral server per request (ECONNRESET, same fix as 18.7/18.12).
      await app.listen(0);
      prisma = app.get(PrismaService);
      categoryId = (await prisma.category.findFirstOrThrow()).id;
      seeded = await seedAll();

      const admin = await prisma.adminUser.create({
        data: {
          username: ADMIN_USERNAME,
          email: `${ADMIN_USERNAME}@212collectorsclub.test`,
          passwordHash: await argon2.hash(ADMIN_PASSWORD, {
            type: argon2.argon2id,
          }),
        },
      });
      adminId = admin.id;
      const res = await request(server())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
        .expect(200);
      adminToken = (res.body as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      delete process.env.LEGAL_REQUIRE_PUBLISHED;
      await prisma.order.deleteMany({
        where: { lines: { some: { productId: { in: productIds } } } },
      });
      await prisma.cart.deleteMany({
        where: {
          OR: [
            { customer: { email: { in: emails } } },
            { items: { some: { productId: { in: productIds } } } },
          ],
        },
      });
      await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      await prisma.adminUser.delete({ where: { id: adminId } });
      // evidence is append-only: it was released by deleting its customers and
      // orders (FK SetNull); purge only deletes the orphans on sandbox versions
      await purgeConsentDocs(sql);
      await app.close();
    });

    describe('AC1 schema', () => {
      it('Consent_Records has no IP/user-agent/birth-date columns; Orders gained four NULLable columns', async () => {
        const cols = (
          await sql(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'Consent_Records' ORDER BY 1`,
          )
        ).map((r) => r.column_name);
        expect(cols).toEqual([
          'acceptedAt',
          'context',
          'customerId',
          'documentVersionId',
          'id',
          'orderId',
          'type',
          'version',
        ]);
        const oc = await sql(
          `SELECT column_name, is_nullable, data_type FROM information_schema.columns
         WHERE table_name = 'Orders' AND column_name IN ('termsVersion','shippingVersion','returnsVersion','termsAcceptedAt') ORDER BY 1`,
        );
        expect(oc).toHaveLength(4);
        expect(oc.every((c) => c.is_nullable === 'YES')).toBe(true);
      });

      it('FKs: customer/order SetNull, document version Restrict (NO ACTION-like)', async () => {
        const rules = await sql(
          `SELECT constraint_name, delete_rule FROM information_schema.referential_constraints
         WHERE constraint_name LIKE 'Consent_Records_%_fkey' ORDER BY 1`,
        );
        expect(rules).toEqual([
          {
            constraint_name: 'Consent_Records_customerId_fkey',
            delete_rule: 'SET NULL',
          },
          {
            constraint_name: 'Consent_Records_documentVersionId_fkey',
            delete_rule: 'RESTRICT',
          },
          {
            constraint_name: 'Consent_Records_orderId_fkey',
            delete_rule: 'SET NULL',
          },
        ]);
      });

      it('historical orders (not created here) keep NULL consent columns (NFR-19.1)', async () => {
        const [r] = await sql(
          `SELECT count(*)::int AS n FROM "Orders" o
         WHERE "termsVersion" IS NOT NULL OR "shippingVersion" IS NOT NULL
            OR "returnsVersion" IS NOT NULL OR "termsAcceptedAt" IS NOT NULL`,
        );
        expect(r.n).toBe(0);
      });
    });

    describe('AC4 register', () => {
      it('without the boxes / without age / with an old or future version: 400 / 409 and NO Customer', async () => {
        const email = emailOf('reg-bad');
        emails.push(email);
        const before = await counts();
        const none = await register(email, {}).expect(400);
        expect((none.body as Err).errorCode).toBe('CONSENT_REQUIRED');
        expect((none.body as Err).details?.missing).toEqual([
          'acceptedTermsVersion',
          'acceptedPrivacyVersion',
          'ageDeclared',
        ]);
        const noAge = await register(email, {
          acceptedTermsVersion: 3,
          acceptedPrivacyVersion: 1,
          ageDeclared: false,
        }).expect(400);
        expect((noAge.body as Err).details?.missing).toEqual(['ageDeclared']);
        // QA 19.4a: non-boolean forms of "true" are CONSENT_REQUIRED too, not the
        // generic validation 400 (the contract of 19.7).
        for (const bad of ['true', 1, 'yes', 0]) {
          const r = await register(email, {
            acceptedTermsVersion: 3,
            acceptedPrivacyVersion: 1,
            ageDeclared: bad,
          }).expect(400);
          expect((r.body as Err).errorCode, JSON.stringify(bad)).toBe(
            'CONSENT_REQUIRED',
          );
          expect((r.body as Err).details?.missing).toEqual(['ageDeclared']);
        }
        for (const terms of [2, 99]) {
          const stale = await register(email, {
            acceptedTermsVersion: terms,
            acceptedPrivacyVersion: 1,
            ageDeclared: true,
          }).expect(409);
          expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
          expect((stale.body as Err).details?.current).toEqual({
            terminos: 3,
            privacidad: 1,
          });
        }
        const after = await counts();
        expect(after.customers).toBe(before.customers);
        expect(after.consents).toBe(before.consents);
      });

      it('valid: TERMS, PRIVACY and AGE_DECLARATION (REGISTER) with the version and a server acceptedAt; nothing else', async () => {
        const c = await customer('reg-ok');
        const rows = await consentsOf({ customerId: c.id });
        expect(rows.map((r) => [r.type, r.version, r.context]).sort()).toEqual(
          [
            ['AGE_DECLARATION', 3, 'REGISTER'],
            ['PRIVACY', 1, 'REGISTER'],
            ['TERMS', 3, 'REGISTER'],
          ].sort(),
        );
        const [dbNow] = await sql(`SELECT now() AS n`);
        for (const r of rows) {
          expect(r.orderId).toBeNull();
          expect(r.documentVersionId).toMatch(/^[0-9a-f-]{36}$/);
          const delta = Math.abs(
            (dbNow.n as Date).getTime() - Date.parse(r.acceptedAt),
          );
          expect(delta).toBeLessThan(60_000); // DB clock, written just now
        }
        // the document version of each row really is that version number
        const v = await sql(
          `SELECT c."type"::text AS type, c."version", v."versionNumber"
         FROM "Consent_Records" c JOIN "Legal_Document_Versions" v ON v."id" = c."documentVersionId"
         WHERE c."customerId" = $1::uuid`,
          [c.id],
        );
        expect(v.every((r) => r.version === r.versionNumber)).toBe(true);
      });

      it('a duplicate email writes nothing and answers like a new one; a duplicate with bad consent is the same 400 as a new one (no oracle)', async () => {
        const c = await customer('reg-dup');
        const before = await counts();
        const dup = await register(c.email).expect(201);
        expect((dup.body as { message: string }).message).toMatch(
          /If this email can be registered/,
        );
        const bad = await register(c.email, {}).expect(400);
        const badNew = await register(emailOf('reg-never'), {}).expect(400);
        expect((bad.body as Err).errorCode).toBe(
          (badNew.body as Err).errorCode,
        );
        expect((bad.body as Err).details).toEqual((badNew.body as Err).details);
        expect(await counts()).toEqual(before);
      });

      it('concurrent registrations of the SAME email: one account, exactly 3 consent rows, no 5xx', async () => {
        const email = emailOf('reg-race');
        emails.push(email);
        const rs = await Promise.all(
          Array.from({ length: 6 }, () => register(email)),
        );
        expect(rs.map((r) => r.status)).toEqual(Array(6).fill(201));
        const [cu] = await sql(
          `SELECT "id" FROM "Customers" WHERE "email" = $1`,
          [email],
        );
        expect(await consentsOf({ customerId: cu.id as string })).toHaveLength(
          3,
        );
      });
    });

    describe('AC5 checkout', () => {
      it('guest or account, flat legacy format or new: no acceptance => 400, stale => 409, and NO Order / StockHold / heldQty', async () => {
        const p = await mkProduct('co-bad');
        const c = await customer('co-bad');
        const guest = await guestCart(p);
        await request(server())
          .post('/api/v1/cart/items')
          .set('Cookie', c.s)
          .send({ productId: p, quantity: 1 })
          .expect(201);
        const before = await counts();
        const heldBefore = (
          await prisma.product.findUniqueOrThrow({ where: { id: p } })
        ).heldQty;
        for (const rail of ['pago_movil', 'stripe']) {
          for (const who of [guest, c.s]) {
            const none = await request(server())
              .post('/api/v1/checkout')
              .set('Cookie', who)
              .send(withBuyerId(checkoutBody({ paymentRail: rail })))
              .expect(400);
            expect((none.body as Err).errorCode).toBe('CONSENT_REQUIRED');
            expect((none.body as Err).details?.missing).toEqual([
              'acceptedTermsVersion',
              'acceptedShippingVersion',
              'acceptedReturnsVersion',
            ]);
            const stale = await request(server())
              .post('/api/v1/checkout')
              .set('Cookie', who)
              .send(
                withBuyerId(
                  checkoutBody({
                    paymentRail: rail,
                    acceptedTermsVersion: 2,
                    acceptedShippingVersion: 1,
                    acceptedReturnsVersion: 1,
                  }),
                ),
              )
              .expect(409);
            expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
            expect((stale.body as Err).details?.current).toEqual({
              terminos: 3,
              envios: 1,
              devoluciones: 1,
            });
          }
        }
        // CHECKOUT_REQUIRE_SHIPPING=false (default) + flat format is NOT a way around it
        expect(process.env.CHECKOUT_REQUIRE_SHIPPING).not.toBe('true');
        const after = await counts();
        expect(after.orders).toBe(before.orders);
        expect(after.holds).toBe(before.holds);
        expect(after.consents).toBe(before.consents);
        expect(
          (await prisma.product.findUniqueOrThrow({ where: { id: p } }))
            .heldQty,
        ).toBe(heldBefore);
      });

      it('with acceptance: the Order stores the 3 versions and termsAcceptedAt, and 3 ConsentRecords (CHECKOUT) are written in the same transaction', async () => {
        const p = await mkProduct('co-ok');
        const guest = await guestCart(p);
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', guest)
          .send(withBuyerId(checkoutBody(seeded.checkoutBody())))
          .expect(201);
        const out = res.body as Checkout;
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: out.orderId },
        });
        expect([
          order.termsVersion,
          order.shippingVersion,
          order.returnsVersion,
        ]).toEqual([3, 1, 1]);
        expect(order.termsAcceptedAt).not.toBeNull();
        const rows = await consentsOf({ orderId: out.orderId });
        expect(rows.map((r) => [r.type, r.version, r.context]).sort()).toEqual(
          [
            ['RETURNS', 1, 'CHECKOUT'],
            ['SHIPPING', 1, 'CHECKOUT'],
            ['TERMS', 3, 'CHECKOUT'],
          ].sort(),
        );
        expect(rows.every((r) => r.customerId === null)).toBe(true);
        // same clock: the order's acceptance instant equals the rows' (one tx)
        expect(
          rows.every(
            (r) =>
              Math.abs(
                Date.parse(r.acceptedAt) - order.termsAcceptedAt!.getTime(),
              ) <= 1, // same transaction clock (ms rounding only)
          ),
        ).toBe(true);
        // the admin order detail and the buyer lookup expose the four fields
        const adm = await request(server())
          .get(`/api/v1/admin/orders/${out.orderId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(adm.body).toMatchObject({
          termsVersion: 3,
          shippingVersion: 1,
          returnsVersion: 1,
          termsAcceptedAt: order.termsAcceptedAt!.toISOString(),
        });
        const look = await request(server())
          .get(`/api/v1/orders/${out.orderId}`)
          .set('Authorization', `Bearer ${out.orderAccessToken}`)
          .expect(200);
        expect(look.body).toMatchObject({ termsVersion: 3, returnsVersion: 1 });
      });

      it('an account checkout (Stripe rail) records customerId; its TERMS counts as accepted for FR-115 (A73)', async () => {
        const p = await mkProduct('co-acct');
        const c = await customer('co-acct');
        await request(server())
          .post('/api/v1/cart/items')
          .set('Cookie', c.s)
          .send({ productId: p, quantity: 1 })
          .expect(201);
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', c.s)
          .send(
            withBuyerId(
              checkoutBody({ paymentRail: 'stripe', ...seeded.checkoutBody() }),
            ),
          )
          .expect(201);
        const rows = await consentsOf({
          orderId: (res.body as Checkout).orderId,
        });
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.customerId === c.id)).toBe(true);
      });

      it('a failure after the consent (no stock) leaves ZERO ConsentRecord and no Order', async () => {
        const p = await mkProduct('co-stock', 1);
        const guest = await guestCart(p, 1);
        await prisma.product.update({ where: { id: p }, data: { heldQty: 1 } }); // sold out meanwhile
        const before = await counts();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', guest)
          .send(withBuyerId(checkoutBody(seeded.checkoutBody())))
          .expect(409);
        expect((res.body as Err).errorCode).toBe('INSUFFICIENT_STOCK');
        expect(await counts()).toEqual(before);
      });
    });

    describe('AC6 concurrency (real Promise.all)', () => {
      it('8 concurrent valid checkouts: 8 orders, exactly 3 ConsentRecords each, no 5xx; 8 stale: only 409', async () => {
        const p = await mkProduct('conc', 100);
        const carts = await Promise.all(
          Array.from({ length: 8 }, () => guestCart(p)),
        );
        const before = await counts();
        const ok = await Promise.all(
          carts.map((ck) =>
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', ck)
              .send(withBuyerId(checkoutBody(seeded.checkoutBody()))),
          ),
        );
        expect(ok.map((r) => r.status)).toEqual(Array(8).fill(201));
        const after = await counts();
        expect(after.orders - before.orders).toBe(8);
        expect(after.consents - before.consents).toBe(24);
        for (const r of ok) {
          expect(
            await consentsOf({ orderId: (r.body as Checkout).orderId }),
          ).toHaveLength(3);
        }
        const carts2 = await Promise.all(
          Array.from({ length: 8 }, () => guestCart(p)),
        );
        const stale = await Promise.all(
          carts2.map((ck) =>
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', ck)
              .send(
                withBuyerId(
                  checkoutBody({
                    ...seeded.checkoutBody(),
                    acceptedTermsVersion: 2,
                  }),
                ),
              ),
          ),
        );
        expect(stale.map((r) => r.status)).toEqual(Array(8).fill(409));
        expect(await counts()).toEqual(after);
      });
    });

    describe('AC7/AC8 re-accept and consent status', () => {
      const status = (c: { s: string }) =>
        request(server()).get('/api/v1/me/consent-status').set('Cookie', c.s);
      const reaccept = (c: { s: string }, body: Record<string, unknown>) =>
        request(server())
          .post('/api/v1/me/consent')
          .set('Cookie', c.s)
          .send(body);

      it('401 without a customer session (an admin token does not authenticate here)', async () => {
        await request(server()).get('/api/v1/me/consent-status').expect(401);
        await request(server()).post('/api/v1/me/consent').send({}).expect(401);
        await request(server())
          .get('/api/v1/me/consent-status')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(401);
      });

      it('pending = never accepted, or older than the last SUBSTANTIAL version in force; a future substantial version never counts', async () => {
        const a = await customer('ra-a'); // accepted terms 3, privacy 1
        expect((await status(a).expect(200)).body).toEqual({
          pending: [],
          ageDeclarationPending: false,
        });
        // v4 NOT substantial, in force: still nothing pending
        await seeded.addVersion('terms', {
          versionNumber: 4,
          effectiveFrom: '-1 hour',
          changeSummary: 'ortografia',
        });
        expect((await status(a).expect(200)).body).toEqual({
          pending: [],
          ageDeclarationPending: false,
        });
        const b = await customer('ra-b'); // accepted terms 4
        // v5 substantial: pending for both (last accepted 3 and 4 < 5)
        await seeded.addVersion('terms', {
          versionNumber: 5,
          effectiveFrom: '-30 minutes',
          isSubstantial: true,
          changeSummary: 'nueva clausula de simulador',
        });
        await seeded.addVersion('terms', {
          versionNumber: 6,
          effectiveFrom: '-10 minutes',
          changeSummary: 'otra correccion',
        });
        for (const c of [a, b]) {
          expect((await status(c).expect(200)).body).toEqual({
            pending: [
              {
                slug: 'terminos',
                version: 6,
                changeSummary: 'otra correccion',
              },
            ],
            ageDeclarationPending: false,
          });
        }
        const c = await customer('ra-c'); // registers at 6
        expect((await status(c).expect(200)).body).toMatchObject({
          pending: [],
        });
      });

      it('POST /me/consent: 400 missing, 409 stale, 400 unknown field; valid records RE_ACCEPT only for what is pending; a repeat and a double click write nothing more', async () => {
        await seeded.addVersion('privacy', {
          versionNumber: 2,
          effectiveFrom: '-5 minutes',
          isSubstantial: true,
          changeSummary: 'nuevo encargado',
        });
        const a = await customer('ra2-a'); // registers at terms 6 / privacy 2
        await seeded.addVersion('privacy', {
          versionNumber: 3,
          effectiveFrom: '-4 minutes',
          isSubstantial: true,
          changeSummary: 'otro encargado',
        });
        expect((await status(a).expect(200)).body).toEqual({
          pending: [
            { slug: 'privacidad', version: 3, changeSummary: 'otro encargado' },
          ],
          ageDeclarationPending: false,
        });
        const none = await reaccept(a, {}).expect(400);
        expect((none.body as Err).errorCode).toBe('CONSENT_REQUIRED');
        // Story 19.4a #7: only what is pending (here privacy) is required.
        expect((none.body as Err).details?.missing).toEqual([
          'acceptedPrivacyVersion',
        ]);
        const stale = await reaccept(a, {
          acceptedTermsVersion: 6,
          acceptedPrivacyVersion: 2,
        }).expect(409);
        expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
        expect((stale.body as Err).details?.current).toEqual({
          terminos: 6,
          privacidad: 3,
        });
        await reaccept(a, { acceptedTermsVersion: 6, nope: 1 }).expect(400);
        const before = (await consentsOf({ customerId: a.id })).length;
        const ok = await reaccept(a, {
          acceptedTermsVersion: 6,
          acceptedPrivacyVersion: 3,
        }).expect(200);
        expect(ok.body).toEqual({ pending: [], ageDeclarationPending: false });
        const rows = await consentsOf({ customerId: a.id });
        const added = rows.filter((r) => r.context === 'RE_ACCEPT');
        expect(added.map((r) => [r.type, r.version])).toEqual([['PRIVACY', 3]]);
        expect(rows).toHaveLength(before + 1);
        // repeat: harmless no-op
        await reaccept(a, {
          acceptedTermsVersion: 6,
          acceptedPrivacyVersion: 3,
        }).expect(200);
        expect(await consentsOf({ customerId: a.id })).toHaveLength(before + 1);
        // double click, concurrently, for a customer whose terms are pending
        const b = await customer('ra2-b');
        await seeded.addVersion('terms', {
          versionNumber: 7,
          effectiveFrom: '-3 minutes',
          isSubstantial: true,
        });
        const rs = await Promise.all(
          Array.from({ length: 6 }, () =>
            reaccept(b, { acceptedTermsVersion: 7, acceptedPrivacyVersion: 3 }),
          ),
        );
        expect(rs.map((r) => r.status)).toEqual(Array(6).fill(200));
        const bRows = (await consentsOf({ customerId: b.id })).filter(
          (r) => r.context === 'RE_ACCEPT',
        );
        expect(bRows.map((r) => [r.type, r.version])).toEqual([['TERMS', 7]]);
      });

      it('a substantial version that is not in force yet never makes anything pending and cannot be accepted', async () => {
        const c = await customer('ra-fut'); // registers at the version in force (7)
        await seeded.addVersion('terms', {
          versionNumber: 8,
          effectiveFrom: '+1 day',
          isSubstantial: true,
        });
        expect((await status(c).expect(200)).body).toEqual({
          pending: [],
          ageDeclarationPending: false,
        });
        const fut = await register(emailOf('ra-fut-2'), {
          ...seeded.registerBody(),
          acceptedTermsVersion: 8,
        }).expect(409);
        expect((fut.body as Err).details?.current).toMatchObject({
          terminos: 7,
        });
        const p = await mkProduct('fut');
        const before = await counts();
        const co = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', await guestCart(p))
          .send(
            withBuyerId(
              checkoutBody({
                ...seeded.checkoutBody(),
                acceptedTermsVersion: 8,
              }),
            ),
          )
          .expect(409);
        expect((co.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
        const after = await counts();
        expect(after.orders).toBe(before.orders);
        expect(after.holds).toBe(before.holds);
      });
    });

    describe('AC9 admin read side', () => {
      it('GET /admin/legal/consents: 401 without a token, 400 without filters or with a non-uuid, empty list for an unknown id', async () => {
        await request(server()).get('/api/v1/admin/legal/consents').expect(401);
        const none = await request(server())
          .get('/api/v1/admin/legal/consents')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(400);
        expect((none.body as Err).errorCode).toBe('CONSENT_FILTER_REQUIRED');
        const bad = await request(server())
          .get('/api/v1/admin/legal/consents?customerId=not-a-uuid')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(400);
        expect((bad.body as Err).errorCode).toBe('CONSENT_FILTER_INVALID');
        expect(await consentsOf({ customerId: randomUUID() })).toEqual([]);
        expect(await consentsOf({ orderId: randomUUID() })).toEqual([]);
      });

      it('lists newest first and exposes only ids, version, context and the DB timestamp', async () => {
        const c = await customer('adm');
        const rows = await consentsOf({ customerId: c.id });
        expect(rows.length).toBeGreaterThanOrEqual(3);
        const times = rows.map((r) => Date.parse(r.acceptedAt));
        expect([...times].sort((x, y) => y - x)).toEqual(times);
        for (const r of rows) {
          expect(Object.keys(r).sort()).toEqual([
            'acceptedAt',
            'context',
            'customerId',
            'documentVersionId',
            'id',
            'orderId',
            'type',
            'version',
          ]);
        }
      });
    });

    describe('AC2 triggers: Consent_Records is append-only', () => {
      it('UPDATE and DELETE of a row linked to a customer or an order fail (also the SetNull "launder" trick); TRUNCATE fails', async () => {
        const c = await customer('trg');
        const p = await mkProduct('trg');
        const g = await guestCart(p);
        const o = (
          await request(server())
            .post('/api/v1/checkout')
            .set('Cookie', g)
            .send(withBuyerId(checkoutBody(seeded.checkoutBody())))
            .expect(201)
        ).body as Checkout;
        const [rc] = await sql(
          `SELECT "id" FROM "Consent_Records" WHERE "customerId" = $1::uuid LIMIT 1`,
          [c.id],
        );
        const [ro] = await sql(
          `SELECT "id" FROM "Consent_Records" WHERE "orderId" = $1::uuid LIMIT 1`,
          [o.orderId],
        );
        for (const id of [rc.id, ro.id]) {
          await expect(
            prisma.$executeRawUnsafe(
              `UPDATE "Consent_Records" SET "version" = 99 WHERE "id" = $1::uuid`,
              id,
            ),
          ).rejects.toThrow(/append-only/);
          await expect(
            prisma.$executeRawUnsafe(
              `UPDATE "Consent_Records" SET "customerId" = NULL, "orderId" = NULL WHERE "id" = $1::uuid`,
              id,
            ),
          ).rejects.toThrow(/append-only/);
          await expect(
            prisma.$executeRawUnsafe(
              `DELETE FROM "Consent_Records" WHERE "id" = $1::uuid`,
              id,
            ),
          ).rejects.toThrow(/append-only/);
        }
        // Story 20.1: with the limited application role TRUNCATE is refused by
        // privileges (permission denied) before the trigger.
        await expect(
          prisma.$executeRawUnsafe(`TRUNCATE "Consent_Records"`),
        ).rejects.toThrow(/append-only|permission denied|42501/);
        expect(await consentsOf({ customerId: c.id })).not.toHaveLength(0);
      });

      it('only the FK SetNull cascade can unlink a row, and only an orphan can be deleted', async () => {
        const c = await customer('trg2');
        const rows = await consentsOf({ customerId: c.id });
        await prisma.customer.delete({ where: { id: c.id } }); // cascade SetNull
        const [r] = await sql(
          `SELECT count(*)::int AS n FROM "Consent_Records" WHERE "id" = ANY($1::uuid[]) AND "customerId" IS NULL`,
          [rows.map((x) => x.id)],
        );
        expect(r.n).toBe(rows.length); // evidence kept, link released
        const del = await prisma.$executeRawUnsafe(
          `DELETE FROM "Consent_Records" WHERE "id" = ANY($1::uuid[]) AND "customerId" IS NULL AND "orderId" IS NULL`,
          rows.map((x) => x.id),
        );
        expect(del).toBe(rows.length);
      });

      it('an acceptance cannot claim a version that does not exist, is not in force, or belongs to another kind of document', async () => {
        const c = await customer('trg3');
        const v = async (slug: string, n: number) =>
          (
            await sql(
              `SELECT v."id" FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id" = v."documentId"
             WHERE d."slug" = $1 AND v."versionNumber" = $2`,
              [slug, n],
            )
          )[0].id as string;
        const ins = (type: string, versionId: string | null, version: number) =>
          prisma.$executeRawUnsafe(
            `INSERT INTO "Consent_Records" ("id","customerId","type","documentVersionId","version","context")
           VALUES (gen_random_uuid(), $1::uuid, $2::"ConsentType", $3::uuid, $4, 'RE_ACCEPT')`,
            c.id,
            type,
            versionId,
            version,
          );
        const terms1 = await v('e2e-terminos', 1);
        await expect(ins('TERMS', terms1, 2)).rejects.toThrow(
          /does not match an effective/,
        );
        await expect(ins('PRIVACY', terms1, 1)).rejects.toThrow(
          /does not match an effective/,
        );
        await expect(ins('TERMS', null, 0)).rejects.toThrow(/version_chk/);
        await expect(ins('TERMS', null, 5)).rejects.toThrow(/version_chk/);
        await expect(ins('TERMS', terms1, 1)).resolves.toBe(1); // control: a true one is fine
      });
    });

    describe('document without a version in force (decision A75)', () => {
      /** Releases every sandbox version's evidence so the documents can be re-seeded. */
      const resetEvidence = async () => {
        await prisma.order.deleteMany({
          where: { lines: { some: { productId: { in: productIds } } } },
        });
        await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      };
      beforeAll(resetEvidence);
      afterEach(async () => {
        delete process.env.LEGAL_REQUIRE_PUBLISHED;
        await resetEvidence();
      });

      it('LEGAL_REQUIRE_PUBLISHED=false: not required, nothing recorded for it (no fake acceptance); a version sent for it is 409', async () => {
        seeded = await seedConsentDocs(sql, {
          terms: [{ versionNumber: 1 }],
          returns: [{ versionNumber: 1 }],
          // no shipping document in force
        });
        const p = await mkProduct('nopub');
        const g1 = await guestCart(p);
        const ok = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', g1)
          .send(
            withBuyerId(
              checkoutBody({
                acceptedTermsVersion: 1,
                acceptedReturnsVersion: 1,
              }),
            ),
          )
          .expect(201);
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: (ok.body as Checkout).orderId },
        });
        expect([
          order.termsVersion,
          order.shippingVersion,
          order.returnsVersion,
        ]).toEqual([1, null, 1]);
        const rows = await consentsOf({ orderId: order.id });
        expect(rows.map((r) => r.type).sort()).toEqual(['RETURNS', 'TERMS']);
        const g2 = await guestCart(p);
        const sent = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', g2)
          .send(
            withBuyerId(
              checkoutBody({
                acceptedTermsVersion: 1,
                acceptedReturnsVersion: 1,
                acceptedShippingVersion: 1,
              }),
            ),
          )
          .expect(409);
        expect((sent.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
        expect((sent.body as Err).details?.stale).toEqual([
          'acceptedShippingVersion',
        ]);
      });

      it('nothing published at all: checkout needs no boxes and records nothing; register still demands the age and stores a version-0 declaration with no document', async () => {
        seeded = await seedConsentDocs(sql, {});
        const p = await mkProduct('nopub2');
        const g = await guestCart(p);
        const ok = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', g)
          .send(withBuyerId(checkoutBody()))
          .expect(201);
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: (ok.body as Checkout).orderId },
        });
        expect(order.termsVersion).toBeNull();
        expect(order.termsAcceptedAt).toBeNull();
        expect(await consentsOf({ orderId: order.id })).toEqual([]);

        const email = emailOf('nopub-reg');
        emails.push(email);
        const noAge = await register(email, {}).expect(400);
        expect((noAge.body as Err).details?.missing).toEqual(['ageDeclared']);
        await register(email, { ageDeclared: true }).expect(201);
        const cu = await prisma.customer.findUniqueOrThrow({
          where: { email },
        });
        const rows = await consentsOf({ customerId: cu.id });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'AGE_DECLARATION',
          version: 0,
          documentVersionId: null,
          context: 'REGISTER',
        });
      });

      it('LEGAL_REQUIRE_PUBLISHED=true: 503 LEGAL_NOT_PUBLISHED for checkout and register, with nothing created', async () => {
        seeded = await seedConsentDocs(sql, { terms: [{ versionNumber: 1 }] });
        process.env.LEGAL_REQUIRE_PUBLISHED = 'true';
        const p = await mkProduct('nopub3');
        const g = await guestCart(p);
        const before = await counts();
        const co = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', g)
          .send(withBuyerId(checkoutBody({ acceptedTermsVersion: 1 })))
          .expect(503);
        expect((co.body as Err).errorCode).toBe('LEGAL_NOT_PUBLISHED');
        expect((co.body as Err).details?.documents).toEqual([
          'envios',
          'devoluciones',
        ]);
        const email = emailOf('nopub-503');
        emails.push(email);
        const rg = await register(email, {
          acceptedTermsVersion: 1,
          ageDeclared: true,
        }).expect(503);
        expect((rg.body as Err).errorCode).toBe('LEGAL_NOT_PUBLISHED');
        expect((rg.body as Err).details?.documents).toEqual(['privacidad']);
        expect(await counts()).toEqual(before);
      });
    });

    describe('Story 19.4a #7: POST /me/consent only requires what is pending', () => {
      const reset = async () => {
        await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      };
      beforeAll(reset);
      afterEach(reset);
      const status = (c: { s: string }) =>
        request(server()).get('/api/v1/me/consent-status').set('Cookie', c.s);
      const reaccept = (c: { s: string }, body: Record<string, unknown>) =>
        request(server())
          .post('/api/v1/me/consent')
          .set('Cookie', c.s)
          .send(body);
      const reAccepts = async (id: string) =>
        (await consentsOf({ customerId: id }))
          .filter((r) => r.context === 'RE_ACCEPT')
          .map((r) => `${r.type}:${r.version}`)
          .sort();
      const insertAccepted = (
        customerId: string,
        type: 'TERMS' | 'PRIVACY',
        slug: string,
        version: number,
      ) =>
        sql(
          `INSERT INTO "Consent_Records" ("id","customerId","type","documentVersionId","version","context")
           SELECT gen_random_uuid(), $1::uuid, $2::"ConsentType", v."id", v."versionNumber", 'RE_ACCEPT'::"ConsentContext"
           FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id" = v."documentId"
           WHERE d."slug" = $3 AND v."versionNumber" = $4`,
          [customerId, type, slug, version],
        );

      it('two real sessions (yy: only terms pending; xx: only privacy pending): the modal of yy, sent with the cookie of xx, is 400 and records nothing; extras are never recorded; stale is 409; atomic and idempotent', async () => {
        seeded = await seedConsentDocs(sql, {
          terms: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
          privacy: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
        });
        const yy = await customer('p7-yy');
        const xx = await customer('p7-xx');
        await seeded.addVersion('terms', {
          versionNumber: 2,
          effectiveFrom: '-2 days',
          isSubstantial: true,
          changeSummary: 'terminos nuevos',
        });
        await seeded.addVersion('privacy', {
          versionNumber: 2,
          effectiveFrom: '-2 days',
          isSubstantial: true,
          changeSummary: 'privacidad nueva',
        });
        // Histories that the API alone cannot produce (it requires every
        // pending document at once): xx already accepted terms 2, yy privacy 2.
        await insertAccepted(xx.id, 'TERMS', 'e2e-terminos', 2);
        await insertAccepted(yy.id, 'PRIVACY', 'e2e-privacidad', 2);
        const pendingOf = async (c: { s: string }) =>
          (
            (await status(c).expect(200)).body as {
              pending: { slug: string }[];
            }
          ).pending.map((p) => p.slug);
        expect(await pendingOf(yy)).toEqual(['terminos']);
        expect(await pendingOf(xx)).toEqual(['privacidad']);
        const xxBefore = await reAccepts(xx.id);
        const yyBefore = await reAccepts(yy.id);

        // The vector: the modal lists what yy has pending (terms 2) but the
        // cookie is now xx's. privacy is pending for xx and was not sent.
        const vec = await reaccept(xx, { acceptedTermsVersion: 2 }).expect(400);
        expect((vec.body as Err).errorCode).toBe('CONSENT_REQUIRED');
        expect((vec.body as Err).details?.missing).toEqual([
          'acceptedPrivacyVersion',
        ]);
        expect(await reAccepts(xx.id)).toEqual(xxBefore);
        expect(await pendingOf(xx)).toEqual(['privacidad']);

        // Atomic: a stale pending version records nothing, even with a good one.
        const stale = await reaccept(yy, {
          acceptedTermsVersion: 2,
          acceptedPrivacyVersion: 99,
        }).expect(409);
        expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
        const staleOwn = await reaccept(yy, { acceptedTermsVersion: 1 }).expect(
          409,
        );
        expect((staleOwn.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
        expect(await reAccepts(yy.id)).toEqual(yyBefore);

        // yy: privacy is not pending, so it is optional. Sent and current: it is
        // ignored (never recorded). Only pending AND sent is written.
        const ok = await reaccept(yy, {
          acceptedTermsVersion: 2,
          acceptedPrivacyVersion: 2,
        }).expect(200);
        expect(ok.body).toEqual({ pending: [], ageDeclarationPending: false });
        expect(await reAccepts(yy.id)).toEqual([...yyBefore, 'TERMS:2'].sort());
        // repeat (with and without the extra): idempotent
        await reaccept(yy, { acceptedTermsVersion: 2 }).expect(200);
        await reaccept(yy, {
          acceptedTermsVersion: 2,
          acceptedPrivacyVersion: 2,
        }).expect(200);
        await reaccept(yy, {}).expect(200);
        expect(await reAccepts(yy.id)).toEqual([...yyBefore, 'TERMS:2'].sort());

        // xx: sending only what is pending works and records only that.
        await reaccept(xx, { acceptedPrivacyVersion: 2 }).expect(200);
        expect(await reAccepts(xx.id)).toEqual(
          [...xxBefore, 'PRIVACY:2'].sort(),
        );
        expect(await pendingOf(xx)).toEqual([]);
        // yy is untouched by xx's acceptance
        expect(await reAccepts(yy.id)).toEqual([...yyBefore, 'TERMS:2'].sort());
      });
    });

    describe('Story 19.4a D2: the age declaration of POST /me/consent carries the Terms version in force', () => {
      const reset = async () => {
        await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      };
      beforeAll(reset);
      afterEach(reset);
      const reaccept = (c: { s: string }, body: unknown) =>
        request(server())
          .post('/api/v1/me/consent')
          .set('Cookie', c.s)
          .send(body as object);
      /**
       * A legacy account WITHOUT an AGE_DECLARATION: the API cannot produce one
       * (register always records it), so the Customer is created directly
       * (no registration) with an argon2id credential, plus the TERMS / PRIVACY
       * acceptance rows (plain INSERTs, which the append-only trigger allows)
       * for the versions in force. No e2e disables an immutability trigger.
       */
      const legacyCustomer = async (k: string) => {
        const email = emailOf(k);
        emails.push(email);
        const id = randomUUID();
        await prisma.customer.create({
          data: {
            id,
            email,
            name: 'Cns Legacy',
            emailVerified: true,
            customeraccounts: {
              create: {
                accountId: id,
                providerId: 'credential',
                password: await argon2.hash(PASSWORD, {
                  type: argon2.argon2id,
                }),
              },
            },
          },
        });
        for (const [key, slug, type] of [
          ['terms', 'e2e-terminos', 'TERMS'],
          ['privacy', 'e2e-privacidad', 'PRIVACY'],
        ] as const) {
          const version = seeded.current[key];
          if (!version) continue;
          await sql(
            `INSERT INTO "Consent_Records" ("id", "customerId", "type", "documentVersionId", "version", "context")
             SELECT gen_random_uuid(), $1::uuid, $2::"ConsentType", v."id", v."versionNumber", 'REGISTER'::"ConsentContext"
             FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id" = v."documentId"
             WHERE d."slug" = $3 AND v."versionNumber" = $4`,
            [id, type, slug, version],
          );
        }
        const res = await request(server())
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD })
          .expect(200);
        return { email, id, s: cookieOf(res, 'cc_session') };
      };
      const ageRows = async (id: string) =>
        (await consentsOf({ customerId: id })).filter(
          (r) => r.type === 'AGE_DECLARATION',
        );
      const termsV2Id = async () =>
        (
          await sql(
            `SELECT v."id" FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id" = v."documentId"
             WHERE d."slug" = 'e2e-terminos' AND v."versionNumber" = 2`,
          )
        )[0].id as string;

      it('no pending documents, Terms v2 in force: {ageDeclared:true} records AGE_DECLARATION with version 2 and the v2 documentVersionId (not 0), with or without a privacy version', async () => {
        seeded = await seedConsentDocs(sql, {
          terms: [
            { versionNumber: 1, effectiveFrom: '-3 days' },
            { versionNumber: 2, effectiveFrom: '-2 days' },
          ],
          privacy: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
        });
        const a = await legacyCustomer('d2-a');
        const b = await legacyCustomer('d2-b');
        const status = await request(server())
          .get('/api/v1/me/consent-status')
          .set('Cookie', a.s)
          .expect(200);
        expect(status.body).toEqual({
          pending: [],
          ageDeclarationPending: true,
        });
        const v2 = await termsV2Id();

        await reaccept(a, { ageDeclared: true }).expect(200);
        const ra = await ageRows(a.id);
        expect(ra.map((r) => [r.version, r.context])).toEqual([
          [2, 'RE_ACCEPT'],
        ]);
        expect(ra[0].documentVersionId).toBe(v2);
        // only the age row: no TERMS / PRIVACY row for a non-pending document
        expect(
          (await consentsOf({ customerId: a.id })).filter(
            (r) => r.context === 'RE_ACCEPT',
          ),
        ).toHaveLength(1);

        await reaccept(b, {
          acceptedPrivacyVersion: 1,
          ageDeclared: true,
        }).expect(200);
        const rb = await ageRows(b.id);
        expect(rb.map((r) => r.version)).toEqual([2]);
        expect(rb[0].documentVersionId).toBe(v2);
        expect(
          (await consentsOf({ customerId: b.id })).filter(
            (r) => r.context === 'RE_ACCEPT',
          ),
        ).toHaveLength(1);
        // repeat: idempotent (age already declared)
        await reaccept(a, { ageDeclared: true }).expect(200);
        expect(await ageRows(a.id)).toHaveLength(1);
      });

      it('Terms pending: TERMS and AGE_DECLARATION share the version in force; and version 0 without a document only when no Terms is in force', async () => {
        seeded = await seedConsentDocs(sql, {
          terms: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
          privacy: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
        });
        const c = await legacyCustomer('d2-c');
        await seeded.addVersion('terms', {
          versionNumber: 2,
          effectiveFrom: '-2 days',
          isSubstantial: true,
          changeSummary: 'terminos nuevos',
        });
        await reaccept(c, {
          acceptedTermsVersion: 2,
          ageDeclared: true,
        }).expect(200);
        const rows = await consentsOf({ customerId: c.id });
        const re = rows.filter((r) => r.context === 'RE_ACCEPT');
        expect(re.map((r) => `${r.type}:${r.version}`).sort()).toEqual([
          'AGE_DECLARATION:2',
          'TERMS:2',
        ]);
        expect(new Set(re.map((r) => r.documentVersionId)).size).toBe(1);

        // Version 0 only when there is no Terms in force at all. The sandbox
        // can only be re-seeded once no account still holds evidence on it.
        await reset();
        seeded = await seedConsentDocs(sql, {});
        const d = await legacyCustomer('d2-d');
        await reaccept(d, { ageDeclared: true }).expect(200);
        const zero = await ageRows(d.id);
        expect(zero).toHaveLength(1);
        expect(zero[0]).toMatchObject({
          version: 0,
          documentVersionId: null,
          context: 'RE_ACCEPT',
        });
      });
    });

    describe('Story 19.4a: odd bodies of POST /me/consent', () => {
      const reset = async () => {
        await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      };
      beforeAll(reset);
      afterEach(reset);

      it('[] is 400 (not a JSON object); {} and an empty body are a harmless no-op; null equals omitted (optional per document, missing when pending)', async () => {
        seeded = await seedConsentDocs(sql, {
          terms: [
            { versionNumber: 1, effectiveFrom: '-3 days' },
            { versionNumber: 2, effectiveFrom: '-2 days', isSubstantial: true },
          ],
          privacy: [{ versionNumber: 1, effectiveFrom: '-3 days' }],
        });
        const c = await customer('odd-a');
        const post = (body?: unknown) =>
          request(server())
            .post('/api/v1/me/consent')
            .set('Cookie', c.s)
            .send(body as object);
        const before = (await consentsOf({ customerId: c.id })).length;
        await post([]).expect(400);
        await post([{ ageDeclared: true }]).expect(400);
        await post('x').expect(400);
        // The customer registered at terms 2: nothing is pending.
        await post({}).expect(200);
        await post().expect(200);
        // null is the same as omitted for a non-pending document...
        await post({
          acceptedTermsVersion: null,
          acceptedPrivacyVersion: null,
        }).expect(200);
        expect((await consentsOf({ customerId: c.id })).length).toBe(before);
        // ...and for a pending one it is "missing", exactly like omitting it.
        await seeded.addVersion('privacy', {
          versionNumber: 2,
          effectiveFrom: '-1 minutes',
          isSubstantial: true,
          changeSummary: 'nueva',
        });
        const res = await post({ acceptedPrivacyVersion: null }).expect(400);
        expect((res.body as Err).errorCode).toBe('CONSENT_REQUIRED');
        expect((res.body as Err).details?.missing).toEqual([
          'acceptedPrivacyVersion',
        ]);
        expect((await consentsOf({ customerId: c.id })).length).toBe(before);
      });
    });

    describe('AC10 Swagger', () => {
      it('documents the new errorCodes on register, checkout, /me/consent and the admin list', async () => {
        const doc = (await request(server()).get('/api/docs-json').expect(200))
          .body as { paths: Record<string, unknown> };
        const text = (p: string) => JSON.stringify(doc.paths[p] ?? null);
        for (const p of [
          '/api/v1/auth/register',
          '/api/v1/checkout',
          '/api/v1/me/consent',
        ]) {
          expect(text(p)).toContain('CONSENT_REQUIRED');
          expect(text(p)).toContain('CONSENT_VERSION_STALE');
          expect(text(p)).toContain('LEGAL_NOT_PUBLISHED');
        }
        expect(text('/api/v1/me/consent-status')).toContain(
          'ageDeclarationPending',
        );
        expect(text('/api/v1/admin/legal/consents')).toContain(
          'CONSENT_FILTER_REQUIRED',
        );
      });
    });
  },
);
