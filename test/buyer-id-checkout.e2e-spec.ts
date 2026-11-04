import { randomInt, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { appCrypto } from './helpers/iddoc-assert.js';
import { registerConsent } from './helpers/legal-consent.js';

const PASSWORD = 'Correct-horse-20-4!';
const ADMIN_PASSWORD = 'correct-horse-battery-staple-20-4';

interface Err {
  errorCode: string;
  details?: { field?: string; reason?: string };
}
interface Chk {
  orderId: string;
  orderAccessToken: string;
}

/** A synthetic V number that cannot collide with real data: 9 digits starting with 9. */
const synth = (): string =>
  `9${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

/**
 * Story 20.4 (AC1-AC3, AC5, AC6, AC8, AC9): buyer fiscal ID in checkout, exact search by cedula,
 * the interim switch CHECKOUT_REQUIRE_BUYER_ID and the expected-account guard. Real Postgres.
 * Own customers / products / orders / admin; every env var restored; synthetic cedulas only.
 */
describe(
  'Buyer fiscal ID in checkout and admin search (e2e, Story 20.4)',
  {
    timeout: 60_000,
  },
  () => {
    let app: NestExpressApplication;
    let prisma: PrismaService;
    let categoryId: string;
    let mrw: { id: string };
    const tag = randomUUID().slice(0, 8);
    const productIds: string[] = [];
    const emails: string[] = [];
    const adminUser = `e2e-buyer-${tag}`;
    let adminToken = '';
    let adminId = '';
    let pid: string;
    const saved = {
      buyer: process.env.CHECKOUT_REQUIRE_BUYER_ID,
      ship: process.env.CHECKOUT_REQUIRE_SHIPPING,
      rif: process.env.RIF_CHECKDIGIT_STRICT,
    };
    const server = () => app.getHttpServer();

    const restore = (): void => {
      for (const [k, v] of [
        ['CHECKOUT_REQUIRE_BUYER_ID', saved.buyer],
        ['CHECKOUT_REQUIRE_SHIPPING', saved.ship],
        ['RIF_CHECKDIGIT_STRICT', saved.rif],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    const cookieOf = (res: request.Response, name: string): string =>
      ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0] as string;

    async function mkProduct(key: string, stock = 500): Promise<string> {
      const p = await prisma.product.create({
        data: {
          name: `Buyer${tag} ${key}`,
          slug: `buyer${tag}-${key}`.toLowerCase(),
          description: 'Created by e2e 20.4.',
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
    }

    async function customer(k: string): Promise<{ id: string; s: string }> {
      const email = `e2e-buyer-${k}-${tag}@212collectorsclub.test`;
      emails.push(email);
      await request(server())
        .post('/api/v1/auth/register')
        .send({
          ...registerConsent(),
          email,
          password: PASSWORD,
          name: 'Buyer Tester',
        })
        .expect(201);
      const c = await prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      });
      const res = await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return { id: c.id, s: cookieOf(res, 'cc_session') };
    }

    const flat = (over: Record<string, unknown> = {}) => ({
      paymentRail: 'pago_movil',
      fulfillmentType: 'delivery',
      recipientName: 'Maria Perez',
      recipientPhone: '0412-1234567',
      addressLine1: 'Av. Test 1',
      city: 'Caracas',
      state: 'Distrito Capital',
      ...over,
    });
    const fresh = (recipient: string, over: Record<string, unknown> = {}) => ({
      paymentRail: 'pago_movil',
      recipientName: 'Maria Perez',
      recipientPhone: '+58 (412) 123-4567',
      recipientIdDoc: `V${recipient}`,
      deliveryMode: 'home_delivery',
      shippingAgencyId: mrw.id,
      state: 'Miranda',
      municipality: 'Baruta',
      parish: 'Las Minas',
      addressLine1: 'Calle 1, Casa 2',
      ...over,
    });

    async function guestCart(productId = pid): Promise<string> {
      const add = await request(server())
        .post('/api/v1/cart/items')
        .send({ productId, quantity: 1 })
        .expect(201);
      return cookieOf(add, 'cartId');
    }
    const guestCheckout = async (b: object) =>
      request(server())
        .post('/api/v1/checkout')
        .set('Cookie', await guestCart())
        .send(b);
    async function accountCheckout(s: string, b: object) {
      await request(server())
        .post('/api/v1/cart/items')
        .set('Cookie', s)
        .send({ productId: pid, quantity: 1 })
        .expect(201);
      return request(server())
        .post('/api/v1/checkout')
        .set('Cookie', s)
        .send(b);
    }

    /** Orders, holds and held stock of this suite's product, to prove a rejection left nothing behind. */
    async function footprint(): Promise<{
      orders: number;
      holds: number;
      heldQty: number;
    }> {
      const [orders, holds, p] = await Promise.all([
        prisma.order.count({ where: { lines: { some: { productId: pid } } } }),
        prisma.stockHold.count({ where: { productId: pid } }),
        prisma.product.findUniqueOrThrow({ where: { id: pid } }),
      ]);
      return { orders, holds, heldQty: p.heldQty };
    }

    const orderRow = (id: string) =>
      prisma.order.findUniqueOrThrow({ where: { id } });

    const adminGet = (path: string) =>
      request(server())
        .get(`/api/v1/admin/orders${path}`)
        .set('Authorization', `Bearer ${adminToken}`);

    /** Captures everything written to stdout/stderr while `fn` runs (the Nest logger prints there). */
    async function captureLogs<T>(
      fn: () => Promise<T>,
    ): Promise<{ out: string; value: T }> {
      const chunks: string[] = [];
      const o = process.stdout.write.bind(process.stdout);
      const e = process.stderr.write.bind(process.stderr);
      const grab =
        (orig: typeof o) =>
        (c: string | Uint8Array, ...rest: unknown[]): boolean => {
          chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
          return (orig as (...a: unknown[]) => boolean)(c, ...rest);
        };
      process.stdout.write = grab(o);
      process.stderr.write = grab(e);
      try {
        const value = await fn();
        return { out: chunks.join(''), value };
      } finally {
        process.stdout.write = o;
        process.stderr.write = e;
      }
    }

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleFixture.createNestApplication<NestExpressApplication>();
      app.use(
        cookieParser(
          app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET'),
        ),
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
      categoryId = (await prisma.category.findFirstOrThrow()).id;
      mrw = await prisma.shippingAgency.findUniqueOrThrow({
        where: { code: 'MRW' },
      });
      pid = await mkProduct('a');

      const passwordHash = await argon2.hash(ADMIN_PASSWORD, {
        type: argon2.argon2id,
      });
      const admin = await prisma.adminUser.create({
        data: {
          username: adminUser,
          email: `${adminUser}@212collectorsclub.test`,
          passwordHash,
        },
      });
      adminId = admin.id;
      const login = await request(server())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: adminUser, password: ADMIN_PASSWORD })
        .expect(200);
      adminToken = (login.body as { accessToken: string }).accessToken;
    });

    beforeEach(() => {
      delete process.env.CHECKOUT_REQUIRE_BUYER_ID;
      delete process.env.CHECKOUT_REQUIRE_SHIPPING;
      delete process.env.RIF_CHECKDIGIT_STRICT;
    });

    afterAll(async () => {
      restore();
      await prisma.order.deleteMany({
        where: { lines: { some: { productId: { in: productIds } } } },
      });
      await prisma.product.updateMany({
        where: { id: { in: productIds } },
        data: { heldQty: 0 },
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
      await prisma.adminUser.deleteMany({ where: { id: adminId } });
      await app.close();
    });

    describe('the interim switch (CHECKOUT_REQUIRE_BUYER_ID)', () => {
      it('default (unset): a checkout WITHOUT buyer ID still sells; the order keeps no buyer ID', async () => {
        const res = await guestCheckout(flat());
        expect(res.status).toBe(201);
        const o = await orderRow((res.body as Chk).orderId);
        expect(o).toMatchObject({
          buyerIdType: null,
          buyerIdDocEnc: null,
          buyerIdDocBlind: null,
          buyerLegalName: null,
        });
      });

      it('exactly "true": the same body is 400 BUYER_ID_REQUIRED, with NO Order and NO StockHold (read per request)', async () => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        const cookie = await guestCart();
        const before = await footprint();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(flat())
          .expect(400);
        expect((res.body as Err).errorCode).toBe('BUYER_ID_REQUIRED');
        expect((res.body as Err).details).toEqual({
          field: 'buyerId',
          reason: 'REQUIRED',
        });
        expect(await footprint()).toEqual(before);
        // the cart survived: it checks out as soon as the body is right
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'false';
        await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(flat())
          .expect(201);
      });

      it.each(['TRUE', 'True', ' true', '1', 'yes', ''])(
        'value %j is NOT exactly true: still accepted without buyer ID',
        async (v) => {
          process.env.CHECKOUT_REQUIRE_BUYER_ID = v;
          expect((await guestCheckout(flat())).status).toBe(201);
        },
      );

      it('with it on, CHECKOUT_REQUIRE_SHIPPING is asked first and both are needed for the legacy storefront to stop selling', async () => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
        const res = await guestCheckout(flat());
        expect(res.status).toBe(400);
        expect((res.body as Err).errorCode).toBe('SHIPPING_REQUIRED');
        // the agency format with a buyer ID passes both
        const ok = await guestCheckout(
          fresh(synth(), { buyerSameAsRecipient: true }),
        );
        expect(ok.status).toBe(201);
      });
    });

    describe('AC1/AC2: validation, no Order and no StockHold on rejection', () => {
      beforeEach(() => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        process.env.RIF_CHECKDIGIT_STRICT = 'true';
      });

      const rejected = async (
        body: object,
        errorCode: string,
        field: string,
        reason?: string,
      ) => {
        const cookie = await guestCart();
        const before = await footprint();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(body);
        expect(res.status).toBe(400);
        const err = res.body as Err;
        expect(err.errorCode).toBe(errorCode);
        expect(err.details?.field).toBe(field);
        if (reason) expect(err.details?.reason).toBe(reason);
        expect(await footprint()).toEqual(before);
      };

      it.each([
        [
          { type: 'V', number: '12345' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_LENGTH',
        ],
        [
          { type: 'V', number: '1234567890' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_LENGTH',
        ],
        [
          { type: 'E', number: 'ABCDEFGH' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_FORMAT',
        ],
        [
          { type: 'P', number: '12345' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_LENGTH',
        ],
        [
          { type: 'J', number: '07013380' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_LENGTH',
        ],
        [
          { type: 'J', number: '070133806' },
          'BUYER_ID_INVALID',
          'buyerId.number',
          'INVALID_CHECK_DIGIT',
        ],
      ])('buyerId %j => %s', async (buyerId, code, field, reason) => {
        await rejected(
          flat({ buyerId, buyerLegalName: 'Empresa Sintetica C.A.' }),
          code,
          field,
          reason,
        );
      });

      it('J / G without buyerLegalName => BUYER_ID_REQUIRED', async () => {
        await rejected(
          flat({ buyerId: { type: 'J', number: '070133805' } }),
          'BUYER_ID_REQUIRED',
          'buyerLegalName',
          'REQUIRED',
        );
        await rejected(
          flat({
            buyerId: { type: 'G', number: '200000031' },
            buyerLegalName: '   ',
          }),
          'BUYER_ID_REQUIRED',
          'buyerLegalName',
        );
      });

      it('buyerSameAsRecipient in the legacy flat format => BUYER_ID_REQUIRED', async () => {
        await rejected(
          flat({ buyerSameAsRecipient: true }),
          'BUYER_ID_REQUIRED',
          'buyerSameAsRecipient',
          'SAME_AS_RECIPIENT_NEEDS_AGENCY_FORMAT',
        );
      });

      it('buyerSameAsRecipient without a recipient cedula => SHIPPING_INVALID on recipientIdDoc (the actionable error)', async () => {
        await rejected(
          fresh('00000000', {
            recipientIdDoc: undefined,
            buyerSameAsRecipient: true,
          }),
          'SHIPPING_INVALID',
          'recipientIdDoc',
          'REQUIRED',
        );
      });

      it('buyerId together with buyerSameAsRecipient:true is a contradiction', async () => {
        await rejected(
          fresh(synth(), {
            buyerId: { type: 'V', number: '12345678' },
            buyerSameAsRecipient: true,
          }),
          'BUYER_ID_INVALID',
          'buyerSameAsRecipient',
          'CONFLICTS_WITH_BUYER_ID',
        );
      });

      it('malformed shapes are a plain 400 (nothing created)', async () => {
        for (const buyerId of [
          'V-12345678',
          5,
          { type: 'X', number: '1' },
          {},
        ]) {
          const cookie = await guestCart();
          const before = await footprint();
          await request(server())
            .post('/api/v1/checkout')
            .set('Cookie', cookie)
            .send(flat({ buyerId }))
            .expect(400);
          expect(await footprint()).toEqual(before);
        }
      });

      it('the error never echoes the number that was sent', async () => {
        const n = synth();
        const cookie = await guestCart();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(flat({ buyerId: { type: 'V', number: `${n}99` } }))
          .expect(400);
        expect(JSON.stringify(res.body)).not.toContain(n);
      });

      it('a RIF with a wrong check digit passes when RIF_CHECKDIGIT_STRICT=false', async () => {
        process.env.RIF_CHECKDIGIT_STRICT = 'false';
        const res = await guestCheckout(
          flat({
            buyerId: { type: 'J', number: '070133806' },
            buyerLegalName: 'Empresa Sintetica C.A.',
          }),
        );
        expect(res.status).toBe(201);
      });
    });

    describe('AC3: what the order stores, for every type, guests and accounts', () => {
      beforeEach(() => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        process.env.RIF_CHECKDIGIT_STRICT = 'true';
      });

      async function expectStored(
        orderId: string,
        type: string,
        canonical: string | null,
        legalName: string | null = null,
      ) {
        const o = await orderRow(orderId);
        expect(o.buyerIdType).toBe(type);
        expect(o.buyerLegalName).toBe(legalName);
        if (canonical === null) return o;
        expect(o.buyerIdDocEnc).toMatch(/^v\d+:/);
        expect(
          appCrypto.checkStored(o.buyerIdDocEnc as string, {
            expectedPlain: canonical,
            blind: o.buyerIdDocBlind,
          }),
        ).toBe('ok');
        expect(o.buyerIdDocBlind).toBe(appCrypto.blindIndexOf(canonical));
        // never the clear value anywhere in the row
        const digits = canonical.replace(/\D/g, '');
        if (digits.length >= 6) {
          expect(JSON.stringify(o)).not.toContain(digits);
        }
        return o;
      }

      it.each([
        ['V', '9'],
        ['E', '8'],
      ])('guest, flat format, explicit %s', async (type, lead) => {
        const n = `${lead}${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
        const res = await guestCheckout(flat({ buyerId: { type, number: n } }));
        expect(res.status).toBe(201);
        await expectStored((res.body as Chk).orderId, type, `${type}-${n}`);
      });

      it('guest, stripe rail, passport', async () => {
        const res = await guestCheckout(
          flat({
            paymentRail: 'stripe',
            buyerId: { type: 'P', number: 'qx 9051736' },
          }),
        );
        expect(res.status).toBe(201);
        await expectStored((res.body as Chk).orderId, 'P', 'P-QX9051736');
      });

      it('J and G: RIF with check digit and legal name', async () => {
        const j = await guestCheckout(
          flat({
            buyerId: { type: 'J', number: '07013380-5' },
            buyerLegalName: '  Banesco   Banco Universal ',
          }),
        );
        expect(j.status).toBe(201);
        await expectStored(
          (j.body as Chk).orderId,
          'J',
          'J-070133805',
          'Banesco Banco Universal',
        );
        const g = await guestCheckout(
          fresh(synth(), {
            buyerId: { type: 'G', number: '200000031' },
            buyerLegalName: 'Ente Publico Sintetico',
          }),
        );
        expect(g.status).toBe(201);
        await expectStored(
          (g.body as Chk).orderId,
          'G',
          'G-200000031',
          'Ente Publico Sintetico',
        );
      });

      it('buyerSameAsRecipient (agency format): the recipient ciphertext and blind are copied', async () => {
        const n = synth();
        const res = await guestCheckout(
          fresh(n, { buyerSameAsRecipient: true }),
        );
        expect(res.status).toBe(201);
        const o = await expectStored((res.body as Chk).orderId, 'V', `V-${n}`);
        expect(o.buyerIdDocEnc).toBe(o.recipientIdDocEnc);
        expect(o.buyerIdDocBlind).toBe(o.recipientIdDocBlind);
      });

      it('buyer different from recipient: both stored independently', async () => {
        const r = synth();
        const b = synth();
        const res = await guestCheckout(
          fresh(r, { buyerId: { type: 'E', number: b } }),
        );
        expect(res.status).toBe(201);
        const o = await expectStored((res.body as Chk).orderId, 'E', `E-${b}`);
        expect(o.recipientIdDocBlind).toBe(appCrypto.blindIndexOf(`V-${r}`));
        expect(o.buyerIdDocBlind).not.toBe(o.recipientIdDocBlind);
      });

      it('account: saved address + buyerSameAsRecipient copies the saved cipher and reads its type', async () => {
        const c = await customer('saved');
        const n = synth();
        const p = appCrypto.protect(`E-${n}`);
        const addr = await prisma.customerAddress.create({
          data: {
            customerId: c.id,
            agencyId: mrw.id,
            deliveryMode: 'HOME_DELIVERY',
            recipientName: 'Saved Name',
            recipientPhone: '04121234567',
            recipientIdDocEnc: p?.enc,
            recipientIdDocBlind: p?.blind,
            state: 'Miranda',
            municipality: 'Baruta',
            parish: 'Las Minas',
            addressLine1: 'Saved line 1',
          },
        });
        const res = await accountCheckout(c.s, {
          paymentRail: 'pago_movil',
          customerAddressId: addr.id,
          buyerSameAsRecipient: true,
        });
        expect(res.status).toBe(201);
        const o = await expectStored((res.body as Chk).orderId, 'E', `E-${n}`);
        expect(o.buyerIdDocEnc).toBe(p?.enc);
        expect(o.customerId).toBe(c.id);
      });

      it('account: a saved address WITHOUT cedula cannot be copied: 400, no Order, no StockHold, cart kept', async () => {
        const c = await customer('nocedula');
        const addr = await prisma.customerAddress.create({
          data: {
            customerId: c.id,
            agencyId: mrw.id,
            deliveryMode: 'HOME_DELIVERY',
            recipientName: 'Saved Name',
            recipientPhone: '04121234567',
            state: 'Miranda',
            municipality: 'Baruta',
            parish: 'Las Minas',
            addressLine1: 'Saved line 1',
          },
        });
        const before = await footprint();
        const res = await accountCheckout(c.s, {
          paymentRail: 'pago_movil',
          customerAddressId: addr.id,
          buyerSameAsRecipient: true,
        });
        expect(res.status).toBe(400);
        expect((res.body as Err).errorCode).toBe('BUYER_ID_REQUIRED');
        expect((res.body as Err).details?.reason).toBe('RECIPIENT_ID_MISSING');
        expect(await footprint()).toEqual(before);
        // the account cart is still there and sells with an explicit buyer
        const ok = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', c.s)
          .send({
            paymentRail: 'pago_movil',
            customerAddressId: addr.id,
            buyerId: { type: 'V', number: synth() },
          });
        expect(ok.status).toBe(201);
      });

      it('historical orders (no buyer ID) are untouched: nothing in 20.4 writes them', async () => {
        const res = await guestCheckout(flat());
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'false';
        const old = await guestCheckout(flat());
        expect(res.status).toBe(400);
        expect(old.status).toBe(201);
        expect(
          (await orderRow((old.body as Chk).orderId)).buyerIdDocEnc,
        ).toBeNull();
      });
    });

    describe('false positives of the cedula-in-name extraction', () => {
      it('a company name with a short typed token stays intact; an explicit buyerId is unaffected', async () => {
        const b = synth();
        const res = await guestCheckout(
          flat({
            recipientName: 'Inversiones G-20000 C.A.',
            buyerId: { type: 'V', number: b },
          }),
        );
        expect(res.status).toBe(201);
        const o = await orderRow((res.body as Chk).orderId);
        expect(o.recipientName).toBe('Inversiones G-20000 C.A.');
        expect(o.recipientIdDocEnc).toBeNull();
        expect(o.buyerIdDocBlind).toBe(appCrypto.blindIndexOf(`V-${b}`));
        const res2 = await guestCheckout(
          flat({ recipientName: 'Edificio P-12345' }),
        );
        const o2 = await orderRow((res2.body as Chk).orderId);
        expect(o2.recipientName).toBe('Edificio P-12345');
        expect(o2.recipientIdDocEnc).toBeNull();
      });

      it('a label with no letter is a V: "Ana CI 12345678" is encrypted and the name is cleaned', async () => {
        const n = synth();
        const res = await guestCheckout(flat({ recipientName: `Ana CI ${n}` }));
        expect(res.status).toBe(201);
        const o = await orderRow((res.body as Chk).orderId);
        expect(o.recipientName).toBe('Ana');
        expect(o.recipientIdDocBlind).toBe(appCrypto.blindIndexOf(`V-${n}`));
        expect(JSON.stringify(o)).not.toContain(n);
      });
    });

    describe('AC5: views carry the buyer masked, never the clear value', () => {
      it('GET /orders/:id (token) and the admin detail/list', async () => {
        const r = synth();
        const b = synth();
        const { out } = await captureLogs(async () => {
          const res = await guestCheckout(
            fresh(r, {
              buyerId: { type: 'J', number: '070133805' },
              buyerLegalName: 'Empresa Sintetica C.A.',
            }),
          );
          expect(res.status).toBe(201);
          const chk = res.body as Chk;
          expect(JSON.stringify(res.body)).not.toContain(r);

          const pub = await request(server())
            .get(`/api/v1/orders/${chk.orderId}`)
            .set('Authorization', `Bearer ${chk.orderAccessToken}`)
            .expect(200);
          const f = (pub.body as { fulfillment: Record<string, unknown> })
            .fulfillment;
          expect(f.buyerIdDoc).toBe('J-****3805');
          expect(f.buyerIdType).toBe('J');
          expect(f.buyerLegalName).toBe('Empresa Sintetica C.A.');
          expect(f.recipientIdDoc).toBe(`V-****${r.slice(-4)}`);
          expect(JSON.stringify(pub.body)).not.toContain(r);
          expect(JSON.stringify(pub.body)).not.toContain('070133805');

          const adm = await request(server())
            .get(`/api/v1/admin/orders/${chk.orderId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);
          expect(JSON.stringify(adm.body)).not.toContain(r);
          expect(JSON.stringify(adm.body)).not.toContain('070133805');
          expect(
            (adm.body as { fulfillment: Record<string, unknown> }).fulfillment
              .buyerIdDoc,
          ).toBe('J-****3805');
          const list = await adminGet('?limit=5').expect(200);
          expect(JSON.stringify(list.body)).not.toContain(r);

          // a rejection that carries the sentinel must not log it either
          process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
          await guestCheckout(
            flat({ buyerId: { type: 'V', number: `${b}77` } }),
          );
        });
        expect(out).not.toContain(r);
        expect(out).not.toContain(b);
        expect(out).not.toContain('070133805');
      });
    });

    describe('AC6: GET /admin/orders?idDoc= (exact blind-index search)', () => {
      it('401 without a token', async () => {
        await request(server())
          .get('/api/v1/admin/orders?idDoc=V-12345678')
          .expect(401);
      });

      it('finds orders by recipient OR buyer, in any accepted spelling; exact only', async () => {
        const r = synth();
        const b = synth();
        const asRecipient = await guestCheckout(
          fresh(r, { buyerId: { type: 'E', number: b } }),
        );
        const asBuyer = await guestCheckout(
          fresh(synth(), { buyerId: { type: 'V', number: r } }),
        );
        const other = await guestCheckout(flat());
        const ids = [asRecipient, asBuyer].map((x) => (x.body as Chk).orderId);

        const { out } = await captureLogs(async () => {
          // V-r is the RECIPIENT of the first order and the BUYER of the second
          for (const spelling of [
            `V-${r}`,
            `v${r}`,
            ` V-${r.slice(0, 1)}.${r.slice(1, 4)}.${r.slice(4)} `,
          ]) {
            const res = await adminGet(
              `?idDoc=${encodeURIComponent(spelling)}`,
            ).expect(200);
            const got = (res.body as { data: { orderId: string }[] }).data
              .map((d) => d.orderId)
              .sort();
            expect(got).toEqual([...ids].sort());
            expect((res.body as { meta: { total: number } }).meta.total).toBe(
              2,
            );
          }
          // the buyer E-b of the first order
          const eb = await adminGet(`?idDoc=E-${b}`).expect(200);
          expect(
            (eb.body as { data: { orderId: string }[] }).data.map(
              (d) => d.orderId,
            ),
          ).toEqual([ids[0]]);
          // same digits, other type: no match
          const wrongType = await adminGet(`?idDoc=E-${r}`).expect(200);
          expect((wrongType.body as { data: unknown[] }).data).toEqual([]);
          // a prefix is a valid-length V of its own (7 digits) and finds nothing: no partial match
          const prefix = await adminGet(`?idDoc=V-${r.slice(0, 7)}`).expect(
            200,
          );
          expect((prefix.body as { data: unknown[] }).data).toEqual([]);
          // combined with other filters (AND)
          const combined = await adminGet(
            `?idDoc=V-${r}&paymentRail=stripe`,
          ).expect(200);
          expect((combined.body as { data: unknown[] }).data).toEqual([]);
          // an invalid search is a 400 that does not echo the value
          const bad = await adminGet(`?idDoc=V-${r.slice(0, 3)}`).expect(400);
          expect((bad.body as Err).errorCode).toBe('ID_DOC_FILTER_INVALID');
          expect(JSON.stringify(bad.body)).not.toContain(r.slice(0, 3));
          for (const v of ['12345678', 'V-****5678', "V-1' OR 1=1", 'V-%']) {
            await adminGet(`?idDoc=${encodeURIComponent(v)}`).expect(400);
          }
          await adminGet('?idDoc=V-12345678&idDoc=V-12345679').expect(400);
        });
        expect(other.status).toBe(201);
        // AC6: no idDoc search parameter reaches a log
        expect(out).not.toContain(r);
        expect(out).not.toContain(b);
      });
    });

    describe('AC8: concurrent checkouts with a valid buyer ID', () => {
      it('8 guests at once (Promise.all): all 201, no 5xx, no duplicates, one hold per order', async () => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        const cookies: string[] = [];
        for (let i = 0; i < 8; i++) cookies.push(await guestCart());
        const before = await footprint();
        const results = await Promise.all(
          cookies.map((c, i) =>
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', c)
              .send(
                i % 2 === 0
                  ? flat({ buyerId: { type: 'V', number: synth() } })
                  : fresh(synth(), { buyerSameAsRecipient: true }),
              ),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
        const ids = results.map((r) => (r.body as Chk).orderId);
        expect(new Set(ids).size).toBe(8);
        const after = await footprint();
        expect(after.orders - before.orders).toBe(8);
        expect(after.holds - before.holds).toBe(8);
        expect(after.heldQty - before.heldQty).toBe(8);
      });

      it('the SAME cart checked out twice at once: exactly one order (the other is 422 EMPTY_CART), never a 5xx', async () => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        const cookie = await guestCart();
        const before = await footprint();
        const body = flat({ buyerId: { type: 'V', number: synth() } });
        const rs = await Promise.all(
          [0, 1, 2].map(() =>
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', cookie)
              .send(body),
          ),
        );
        const statuses = rs.map((r) => r.status).sort();
        expect(statuses).toEqual([201, 422, 422]);
        expect((await footprint()).orders - before.orders).toBe(1);
      });

      it('same buyer in many concurrent orders is fine (equal blind index is expected, A97)', async () => {
        process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
        const n = synth();
        const cookies = await Promise.all([
          guestCart(),
          guestCart(),
          guestCart(),
        ]);
        const rs = await Promise.all(
          cookies.map((c) =>
            request(server())
              .post('/api/v1/checkout')
              .set('Cookie', c)
              .send(flat({ buyerId: { type: 'V', number: n } })),
          ),
        );
        expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
        const rows = await Promise.all(
          rs.map((r) => orderRow((r.body as Chk).orderId)),
        );
        expect(new Set(rows.map((o) => o.buyerIdDocBlind)).size).toBe(1);
        // ... with a fresh IV each: the ciphertexts differ
        expect(new Set(rows.map((o) => o.buyerIdDocEnc)).size).toBe(3);
        const found = await adminGet(`?idDoc=V-${n}`).expect(200);
        expect((found.body as { meta: { total: number } }).meta.total).toBe(3);
      });
    });

    describe('expectedCustomerId (race between /auth/me and POST /checkout)', () => {
      it('another account in the session: 409 CHECKOUT_ACCOUNT_MISMATCH, no Order, no StockHold, the cart of B is kept', async () => {
        const a = await customer('exp-a');
        const b = await customer('exp-b');
        await request(server())
          .post('/api/v1/cart/items')
          .set('Cookie', b.s)
          .send({ productId: pid, quantity: 1 })
          .expect(201);
        const before = await footprint();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', b.s)
          .send(
            fresh(synth(), {
              expectedCustomerId: a.id,
              buyerSameAsRecipient: true,
            }),
          );
        expect(res.status).toBe(409);
        expect((res.body as Err).errorCode).toBe('CHECKOUT_ACCOUNT_MISMATCH');
        expect(await footprint()).toEqual(before);
        expect(await prisma.cart.count({ where: { customerId: b.id } })).toBe(
          1,
        );
        // the right id sells
        const ok = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', b.s)
          .send(
            fresh(synth(), {
              expectedCustomerId: b.id,
              buyerSameAsRecipient: true,
            }),
          );
        expect(ok.status).toBe(201);
        expect((await orderRow((ok.body as Chk).orderId)).customerId).toBe(
          b.id,
        );
      });

      it('no session but an account expected: 409; null expects a guest', async () => {
        const a = await customer('exp-guest');
        const cookie = await guestCart();
        const before = await footprint();
        const res = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(flat({ expectedCustomerId: a.id }));
        expect(res.status).toBe(409);
        expect(await footprint()).toEqual(before);
        const guestOk = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', cookie)
          .send(flat({ expectedCustomerId: null }));
        expect(guestOk.status).toBe(201);
        // an account session while a guest is expected
        const wrong = await request(server())
          .post('/api/v1/checkout')
          .set('Cookie', a.s)
          .send(flat({ expectedCustomerId: null }));
        expect(wrong.status).toBe(409);
      });

      it('a malformed id is a plain 400', async () => {
        await request(server())
          .post('/api/v1/checkout')
          .send(flat({ expectedCustomerId: 'not-a-uuid' }))
          .expect(400);
      });
    });

    describe('SHIPPING_INVALID carries details.field / details.reason', () => {
      it('over HTTP: the cedula field is named', async () => {
        const res = await guestCheckout(fresh('1', { recipientIdDoc: 'V-12' }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          errorCode: 'SHIPPING_INVALID',
          details: { field: 'recipientIdDoc', reason: 'INVALID' },
        });
      });
    });

    describe('AC9: Swagger documents the error codes', () => {
      it('/api/docs-json', async () => {
        const doc = (await request(server()).get('/api/docs-json').expect(200))
          .body as {
          paths: Record<
            string,
            Record<
              string,
              { responses: Record<string, { description?: string }> }
            >
          >;
        };
        const text = JSON.stringify(
          doc.paths['/api/v1/checkout'].post.responses,
        );
        for (const code of [
          'BUYER_ID_REQUIRED',
          'BUYER_ID_INVALID',
          'CHECKOUT_ACCOUNT_MISMATCH',
          'SHIPPING_INVALID',
        ]) {
          expect(text).toContain(code);
        }
        const list = JSON.stringify(doc.paths['/api/v1/admin/orders'].get);
        expect(list).toContain('idDoc');
        expect(list).toContain('ID_DOC_FILTER_INVALID');
        const schemas = JSON.stringify(
          (
            doc as unknown as {
              components: { schemas: Record<string, unknown> };
            }
          ).components.schemas.CheckoutDto,
        );
        for (const f of [
          'buyerId',
          'buyerSameAsRecipient',
          'buyerLegalName',
          'expectedCustomerId',
        ]) {
          expect(schemas).toContain(f);
        }
      });
    });
  },
);
