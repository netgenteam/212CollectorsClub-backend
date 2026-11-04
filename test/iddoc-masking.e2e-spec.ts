import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { appCrypto, expectOnlyEncrypted } from './helpers/iddoc-assert.js';
import { registerConsent } from './helpers/legal-consent.js';

const PASSWORD = 'Correct-horse-20-3!';
/** Synthetic sentinel (no real person): its digits must never appear in any non-admin response or log. */
const SENTINEL_DIGITS = '70123456';
const SENTINEL = `V-${SENTINEL_DIGITS}`;
const MASKED = 'V-****3456';

interface Addr {
  id: string;
  recipientIdDoc: string | null;
}

/**
 * Story 20.3 (AC2, AC3, AC8): the cedula is written only encrypted and leaves every view masked.
 * Real Postgres through the app (own customers/orders are removed afterwards; the real rows are
 * never touched). Nothing here writes "Audit_Events".
 */
describe('ID document masking (e2e, Story 20.3)', { timeout: 60000 }, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tag = randomUUID().slice(0, 8);
  const adminUser = `e2e-20-3-${tag}`;
  let adminId: string;
  let token: string;
  let productId: string;
  let agencyId: string;
  const customerIds: string[] = [];
  const emails: string[] = [];
  const orderIds: string[] = [];
  const logged: string[] = [];
  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const cookieOf = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  async function customer(k: string): Promise<{ id: string; s: string }> {
    const email = `e2e-20-3-${k}-${tag}@212collectorsclub.test`;
    emails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({
        ...registerConsent(),
        email,
        password: PASSWORD,
        name: 'Mask Tester',
      })
      .expect(201);
    const c = await prisma.customer.update({
      where: { email },
      data: { emailVerified: true },
    });
    customerIds.push(c.id);
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { id: c.id, s: cookieOf(res, 'cc_session') };
  }
  const addrBody = (over: Record<string, unknown> = {}) => ({
    agencyId,
    deliveryMode: 'home_delivery',
    recipientName: 'Maria Perez',
    recipientPhone: '+58 (412) 123-4567',
    recipientIdDoc: SENTINEL.toLowerCase().replace('-', ' '),
    state: 'Miranda',
    municipality: 'Baruta',
    addressLine1: 'Calle 1, Casa 2',
    ...over,
  });
  async function checkout(s: string | null, body: object) {
    const add = request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity: 1 });
    if (s) void add.set('Cookie', s);
    const added = await add.expect(201);
    return request(server())
      .post('/api/v1/checkout')
      .set('Cookie', s ?? cookieOf(added, 'cartId'))
      .send(body);
  }
  const noClearValue = (body: unknown): void => {
    const json = JSON.stringify(body);
    expect(json).not.toContain(SENTINEL_DIGITS);
    expect(json).not.toMatch(/v\d+:[A-Za-z0-9_-]{16}:/); // nor the ciphertext
    expect(json).not.toMatch(/IdDocEnc|IdDocBlind/);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    delete process.env.CHECKOUT_REQUIRE_SHIPPING;
    agencyId = (
      await prisma.shippingAgency.findFirstOrThrow({
        where: { code: 'MRW', isActive: true },
      })
    ).id;
    productId = (
      await prisma.product.create({
        data: {
          name: `M203 ${tag}`,
          slug: `m203-${tag}`,
          description: 'Created by e2e 20.3.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '5.00',
          stock: 100,
          heldQty: 0,
          isActive: true,
          categoryId: (await prisma.category.findFirstOrThrow()).id,
        },
      })
    ).id;
    adminId = (
      await prisma.adminUser.create({
        data: {
          username: adminUser,
          email: `${adminUser}@212collectorsclub.test`,
          passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        },
      })
    ).id;
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: adminUser, password: PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    // everything the app logs during this suite is captured to prove it holds no cedula
    for (const lvl of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      vi.spyOn(Logger.prototype, lvl).mockImplementation(
        (m: unknown) => void logged.push(JSON.stringify(m)),
      );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.order.deleteMany({
      where: {
        OR: [{ id: { in: orderIds } }, { lines: { some: { productId } } }],
      },
    });
    await prisma.product.updateMany({
      where: { id: productId },
      data: { heldQty: 0 },
    });
    await prisma.cart.deleteMany({
      where: {
        OR: [
          { customer: { email: { in: emails } } },
          { items: { some: { productId } } },
        ],
      },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  describe('address book (AC2, AC3)', () => {
    it('create: stored only encrypted (plain NULL), returned masked; list is masked too', async () => {
      const c = await customer('book');
      const res = await request(server())
        .post('/api/v1/auth/addresses')
        .set('Cookie', c.s)
        .send(addrBody())
        .expect(201);
      const a = res.body as Addr;
      expect(a.recipientIdDoc).toBe(MASKED);
      noClearValue(res.body);
      const row = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: a.id },
      });
      expectOnlyEncrypted(row, SENTINEL);
      const list = await request(server())
        .get('/api/v1/auth/addresses')
        .set('Cookie', c.s)
        .expect(200);
      expect((list.body as { data: Addr[] }).data[0].recipientIdDoc).toBe(
        MASKED,
      );
      noClearValue(list.body);
    });

    it('edit: absent / blank / null / the MASKED value keep the stored cedula; a new one is re-encrypted; invalid is 400', async () => {
      const c = await customer('edit');
      const a = (
        await request(server())
          .post('/api/v1/auth/addresses')
          .set('Cookie', c.s)
          .send(addrBody())
          .expect(201)
      ).body as Addr;
      const before = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: a.id },
      });
      const patch = (b: object) =>
        request(server())
          .patch(`/api/v1/auth/addresses/${a.id}`)
          .set('Cookie', c.s)
          .send(b);

      for (const v of [
        undefined,
        '',
        '   ',
        null,
        MASKED,
        'V-****',
        '****3456',
      ]) {
        const body =
          v === undefined
            ? { state: 'Zulia' }
            : { state: 'Zulia', recipientIdDoc: v };
        const r = await patch(body).expect(200);
        expect((r.body as Addr).recipientIdDoc).toBe(MASKED);
        const row = await prisma.customerAddress.findUniqueOrThrow({
          where: { id: a.id },
        });
        // byte-identical ciphertext and index: the masked echo did not overwrite anything
        expect(row.recipientIdDocEnc).toBe(before.recipientIdDocEnc);
        expect(row.recipientIdDocBlind).toBe(before.recipientIdDocBlind);
        expectOnlyEncrypted(row, SENTINEL);
      }
      // the masked value as the ONLY field is accepted as "no change"
      await patch({ recipientIdDoc: MASKED }).expect(200);

      const changed = await patch({ recipientIdDoc: 'e 87.654.321' }).expect(
        200,
      );
      expect((changed.body as Addr).recipientIdDoc).toBe('E-****4321');
      const row = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: a.id },
      });
      expectOnlyEncrypted(row, 'E-87654321');
      expect(row.recipientIdDocEnc).not.toBe(before.recipientIdDocEnc);

      const bad = await patch({ recipientIdDoc: 'X-1' }).expect(400);
      expect((bad.body as { errorCode: string }).errorCode).toBe(
        'SHIPPING_INVALID',
      );
      expect(JSON.stringify(bad.body)).not.toContain('X-1');
    });

    it('create with the masked value is a 400 (it is not a cedula)', async () => {
      const c = await customer('maskedcreate');
      const r = await request(server())
        .post('/api/v1/auth/addresses')
        .set('Cookie', c.s)
        .send(addrBody({ recipientIdDoc: MASKED }))
        .expect(400);
      expect((r.body as { errorCode: string }).errorCode).toBe(
        'SHIPPING_INVALID',
      );
      expect(
        await prisma.customerAddress.count({ where: { customerId: c.id } }),
      ).toBe(0);
    });

    it('a legacy row (plain only, before the backfill) is served masked and an edit without a cedula leaves it as is', async () => {
      const c = await customer('legacy');
      const row = await prisma.customerAddress.create({
        data: {
          customerId: c.id,
          agencyId,
          deliveryMode: 'HOME_DELIVERY',
          recipientName: 'L',
          recipientPhone: '04121234567',
          recipientIdDoc: SENTINEL,
          state: 'Miranda',
          municipality: 'Baruta',
          addressLine1: 'x',
        },
      });
      const list = await request(server())
        .get('/api/v1/auth/addresses')
        .set('Cookie', c.s)
        .expect(200);
      expect((list.body as { data: Addr[] }).data[0].recipientIdDoc).toBe(
        MASKED,
      );
      noClearValue(list.body);
      await request(server())
        .patch(`/api/v1/auth/addresses/${row.id}`)
        .set('Cookie', c.s)
        .send({ state: 'Zulia' })
        .expect(200);
      const after = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.recipientIdDoc).toBe(SENTINEL); // untouched until the backfill
      expect(after.recipientIdDocEnc).toBeNull();
    });
  });

  describe('orders (AC2, AC3, AC8): guest explicit cedula and account saved address', () => {
    let guestOrder: { orderId: string; orderAccessToken: string };
    let accountOrder: { orderId: string };
    let acc: { id: string; s: string };

    it('guest checkout with a cedula: Order stores only Enc/Blind; the public lookup is masked', async () => {
      const res = await checkout(null, {
        paymentRail: 'pago_movil',
        recipientName: 'Guest',
        recipientPhone: '04121234567',
        recipientIdDoc: ` ${SENTINEL.toLowerCase()} `,
        deliveryMode: 'home_delivery',
        shippingAgencyId: agencyId,
        addressLine1: 'Calle',
        state: 'Miranda',
        municipality: 'Baruta',
        ...registerConsent(),
      });
      expect(res.status).toBe(201);
      noClearValue(res.body);
      guestOrder = res.body as typeof guestOrder;
      orderIds.push(guestOrder.orderId);
      expectOnlyEncrypted(
        await prisma.order.findUniqueOrThrow({
          where: { id: guestOrder.orderId },
        }),
        SENTINEL,
      );
      const view = await request(server())
        .get(`/api/v1/orders/${guestOrder.orderId}`)
        .set('Authorization', `Bearer ${guestOrder.orderAccessToken}`)
        .expect(200);
      expect(
        (view.body as { fulfillment: { recipientIdDoc: string } }).fulfillment
          .recipientIdDoc,
      ).toBe(MASKED);
      noClearValue(view.body);
    });

    it('checkout with a masked cedula in the body is 400 SHIPPING_INVALID and creates no order', async () => {
      const before = await prisma.order.count({
        where: { lines: { some: { productId } } },
      });
      const res = await checkout(null, {
        paymentRail: 'pago_movil',
        recipientName: 'Guest',
        recipientPhone: '04121234567',
        recipientIdDoc: MASKED,
        deliveryMode: 'home_delivery',
        shippingAgencyId: agencyId,
        addressLine1: 'Calle',
        state: 'Miranda',
        municipality: 'Baruta',
        ...registerConsent(),
      });
      expect(res.status).toBe(400);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'SHIPPING_INVALID',
      );
      expect(
        await prisma.order.count({ where: { lines: { some: { productId } } } }),
      ).toBe(before);
    });

    it('account checkout from the address book COPIES Enc/Blind; customer views and admin detail are masked', async () => {
      acc = await customer('acct');
      const a = (
        await request(server())
          .post('/api/v1/auth/addresses')
          .set('Cookie', acc.s)
          .send(addrBody())
          .expect(201)
      ).body as Addr;
      const addrRow = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: a.id },
      });
      const res = await checkout(acc.s, {
        paymentRail: 'pago_movil',
        customerAddressId: a.id,
        ...registerConsent(),
      });
      expect(res.status).toBe(201);
      accountOrder = res.body as typeof accountOrder;
      orderIds.push(accountOrder.orderId);
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: accountOrder.orderId },
      });
      expectOnlyEncrypted(row, SENTINEL);
      expect(row.recipientIdDocEnc).toBe(addrRow.recipientIdDocEnc); // the very same ciphertext: copied, not re-made
      expect(row.recipientIdDocBlind).toBe(addrRow.recipientIdDocBlind);

      const own = await request(server())
        .get(`/api/v1/auth/orders/${accountOrder.orderId}`)
        .set('Cookie', acc.s)
        .expect(200);
      expect(
        (own.body as { fulfillment: { recipientIdDoc: string } }).fulfillment
          .recipientIdDoc,
      ).toBe(MASKED);
      noClearValue(own.body);
      const list = await request(server())
        .get('/api/v1/auth/orders')
        .set('Cookie', acc.s)
        .expect(200);
      noClearValue(list.body);
      expect(JSON.stringify(list.body)).toContain(MASKED);

      const admin = await request(server())
        .get(`/api/v1/admin/orders/${accountOrder.orderId}`)
        .set(auth())
        .expect(200);
      expect(
        (admin.body as { fulfillment: { recipientIdDoc: string } }).fulfillment
          .recipientIdDoc,
      ).toBe(MASKED);
      noClearValue(admin.body);
      const adminList = await request(server())
        .get('/api/v1/admin/orders?limit=50')
        .set(auth())
        .expect(200);
      noClearValue(adminList.body);
    });

    it('a legacy order (plain only) is still served masked, and the order views expose the new buyer fields as null', async () => {
      const legacy = await prisma.order.create({
        data: {
          status: 'PENDING_VERIFICATION',
          paymentRail: 'PAGO_MOVIL',
          fulfillmentType: 'DELIVERY',
          recipientName: 'Old',
          recipientPhone: '1',
          totalUsd: '1.00',
          accessTokenHash: 'x'.repeat(8) + tag,
          recipientIdDoc: SENTINEL,
          customerId: acc.id,
        },
      });
      orderIds.push(legacy.id);
      const own = await request(server())
        .get(`/api/v1/auth/orders/${legacy.id}`)
        .set('Cookie', acc.s)
        .expect(200);
      expect(own.body).toMatchObject({
        fulfillment: {
          recipientIdDoc: MASKED,
          buyerIdDoc: null,
          buyerIdType: null,
          buyerLegalName: null,
        },
      });
      noClearValue(own.body);
    });

    it('a malformed Enc is never read as a legacy value: null in the view, value-free log', async () => {
      const o = await prisma.order.create({
        data: {
          status: 'PENDING_VERIFICATION',
          paymentRail: 'PAGO_MOVIL',
          fulfillmentType: 'DELIVERY',
          recipientName: 'Odd',
          recipientPhone: '1',
          totalUsd: '1.00',
          accessTokenHash: 'y'.repeat(8) + tag,
          recipientIdDoc: SENTINEL,
          recipientIdDocEnc: 'V-99999999',
          customerId: acc.id,
        },
      });
      orderIds.push(o.id);
      const own = await request(server())
        .get(`/api/v1/auth/orders/${o.id}`)
        .set('Cookie', acc.s)
        .expect(200);
      expect(
        (own.body as { fulfillment: { recipientIdDoc: unknown } }).fulfillment
          .recipientIdDoc,
      ).toBeNull();
      noClearValue(own.body);
      expect(logged.join('|')).toContain('IDDOC_ENC_MALFORMED');
    });

    describe('flat format: the storefront put the cedula inside recipientName (the real path of the shop)', () => {
      const flat = (over: Record<string, unknown>) => ({
        paymentRail: 'pago_movil',
        fulfillmentType: 'delivery',
        recipientName: 'Ana Prueba',
        recipientPhone: '04121234567',
        addressLine1: 'Calle 1',
        city: 'Caracas',
        state: 'Miranda',
        ...registerConsent(),
        ...over,
      });
      const viewsOf = async (o: {
        orderId: string;
        orderAccessToken: string;
      }) => {
        const lookup = await request(server())
          .get(`/api/v1/orders/${o.orderId}`)
          .set('Authorization', `Bearer ${o.orderAccessToken}`)
          .expect(200);
        const admin = await request(server())
          .get(`/api/v1/admin/orders/${o.orderId}`)
          .set(auth())
          .expect(200);
        const list = await request(server())
          .get('/api/v1/admin/orders?limit=100')
          .set(auth())
          .expect(200);
        return {
          lookup: lookup.body as unknown,
          admin: admin.body as unknown,
          list: list.body as unknown,
        };
      };

      it.each([
        [
          'old frontend: "Name (V-…)"',
          { recipientName: `Ana Prueba (${SENTINEL})` },
        ],
        [
          'trailing, no parentheses',
          { recipientName: `Ana Prueba ${SENTINEL}` },
        ],
        [
          'spaces and lowercase',
          { recipientName: 'Ana Prueba (  v 70123456 )' },
        ],
        ['new frontend: own field', { recipientIdDoc: SENTINEL }],
      ])(
        '%s: stored clean + encrypted, every view clean and masked',
        async (_n, over) => {
          const res = await checkout(null, flat(over));
          expect(res.status).toBe(201);
          noClearValue(res.body);
          const o = res.body as { orderId: string; orderAccessToken: string };
          orderIds.push(o.orderId);
          const row = await prisma.order.findUniqueOrThrow({
            where: { id: o.orderId },
          });
          expect(row.recipientName).toBe('Ana Prueba');
          expectOnlyEncrypted(row, SENTINEL);
          const v = await viewsOf(o);
          for (const body of [v.lookup, v.admin, v.list]) noClearValue(body);
          expect(
            (
              v.lookup as {
                fulfillment: { recipientName: string; recipientIdDoc: string };
              }
            ).fulfillment,
          ).toMatchObject({
            recipientName: 'Ana Prueba',
            recipientIdDoc: MASKED,
          });
          expect(
            (
              v.admin as {
                fulfillment: { recipientName: string; recipientIdDoc: string };
              }
            ).fulfillment,
          ).toMatchObject({
            recipientName: 'Ana Prueba',
            recipientIdDoc: MASKED,
          });
        },
      );

      it('a name without a cedula, even one with digits, is stored as typed', async () => {
        const res = await checkout(null, flat({ recipientName: 'Ana 3era' }));
        expect(res.status).toBe(201);
        const o = res.body as { orderId: string };
        orderIds.push(o.orderId);
        const row = await prisma.order.findUniqueOrThrow({
          where: { id: o.orderId },
        });
        expect(row.recipientName).toBe('Ana 3era');
        expect(row.recipientIdDocEnc).toBeNull();
      });

      it('an invalid or masked recipientIdDoc in the flat format is 400 and creates no order', async () => {
        const before = await prisma.order.count({
          where: { recipientName: 'Flat Bad' },
        });
        for (const bad of ['abc', MASKED, `${SENTINEL}*`]) {
          const res = await checkout(
            null,
            flat({ recipientName: 'Flat Bad', recipientIdDoc: bad }),
          );
          expect(res.status).toBe(400);
          noClearValue(res.body);
        }
        expect(
          await prisma.order.count({ where: { recipientName: 'Flat Bad' } }),
        ).toBe(before);
      });

      it('an order saved BEFORE the backfill (cedula still in the name) is served clean by every view', async () => {
        const res = await checkout(null, flat({}));
        const o = res.body as { orderId: string; orderAccessToken: string };
        orderIds.push(o.orderId);
        await prisma.$executeRaw`UPDATE "Orders" SET "recipientName" = ${`Ana Prueba (${SENTINEL})`} WHERE id = ${o.orderId}::uuid`;
        const v = await viewsOf(o);
        for (const body of [v.lookup, v.admin, v.list]) noClearValue(body);
        expect(
          (v.lookup as { fulfillment: { recipientName: string } }).fulfillment
            .recipientName,
        ).toBe('Ana Prueba');
        const item = (
          v.list as { data: Array<{ orderId: string; recipientName: string }> }
        ).data.find((x) => x.orderId === o.orderId);
        expect(item?.recipientName).toBe('Ana Prueba');
      });
    });

    it('the order cedula is recoverable (decrypts to the value) and was never purged or masked in the table', async () => {
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: guestOrder.orderId },
      });
      expect(
        appCrypto.checkStored(row.recipientIdDocEnc as string, {
          expectedPlain: SENTINEL,
        }),
      ).toBe('ok');
    });
  });

  it('nothing the app logged during the suite contains the cedula (NFR-20.5)', () => {
    const all = logged.join('|');
    expect(all).not.toContain(SENTINEL_DIGITS);
    expect(all).not.toMatch(/v\d+:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:/);
  });
});
