import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const PASSWORD = 'Correct-horse-17-4!';
interface Err {
  errorCode: string;
  details?: { errors?: { field: string; code: string }[] };
}
interface Chk {
  orderId: string;
}

/**
 * Story 17.4 (FR-86/87, AD-74): checkout with agency shipping, snapshot,
 * pickup rejection and the CHECKOUT_REQUIRE_SHIPPING flag. Real Postgres.
 * Own customers/products/agency/orders; env restored in afterAll.
 */
describe('Checkout shipping (e2e, Story 17.4)', { timeout: 30000 }, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let categoryId: string;
  let mrw: { id: string };
  let domesa: { id: string };
  const tag = randomUUID().slice(0, 8);
  const productIds: string[] = [];
  const emails: string[] = [];
  const agencyIds: string[] = [];
  const originalFlag = process.env.CHECKOUT_REQUIRE_SHIPPING;
  const server = () => app.getHttpServer();

  const cookieOf = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  async function mkProduct(key: string): Promise<string> {
    const p = await prisma.product.create({
      data: {
        name: `Ship${tag} ${key}`,
        slug: `ship${tag}-${key}`.toLowerCase(),
        description: 'Created by e2e 17.4.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '5.00',
        stock: 100,
        heldQty: 0,
        isActive: true,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }
  let pid: string;

  async function customer(k: string): Promise<{ id: string; s: string }> {
    const email = `e2e-ship-${k}-${tag}@212collectorsclub.test`;
    emails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Ship Tester' })
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
  const fresh = (over: Record<string, unknown> = {}) => ({
    paymentRail: 'pago_movil',
    recipientName: 'Maria Perez',
    recipientPhone: '+58 (412) 123-4567',
    recipientIdDoc: 'v12345678',
    deliveryMode: 'home_delivery',
    shippingAgencyId: mrw.id,
    state: 'Miranda',
    municipality: 'Baruta',
    parish: 'Las Minas',
    addressLine1: 'Calle 1, Casa 2',
    referencePoint: 'Frente a la plaza',
    ...over,
  });

  async function guestCart(): Promise<string> {
    const add = await request(server())
      .post('/api/v1/cart/items')
      .send({ productId: pid, quantity: 1 })
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
    return request(server()).post('/api/v1/checkout').set('Cookie', s).send(b);
  }
  const mkAddr = async (
    cid: string,
    over: Record<string, unknown> = {},
  ): Promise<string> =>
    (
      await prisma.customerAddress.create({
        data: {
          customerId: cid,
          agencyId: mrw.id,
          deliveryMode: 'HOME_DELIVERY',
          recipientName: 'Saved Name',
          recipientPhone: '04121234567',
          recipientIdDoc: 'V-12345678',
          state: 'Miranda',
          municipality: 'Baruta',
          parish: 'Las Minas',
          addressLine1: 'Saved line 1',
          addressLine2: 'Saved line 2',
          referencePoint: 'Saved ref',
          ...over,
        },
      })
    ).id;

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
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    mrw = await prisma.shippingAgency.findUniqueOrThrow({
      where: { code: 'MRW' },
    });
    domesa = await prisma.shippingAgency.findUniqueOrThrow({
      where: { code: 'DOMESA' },
    });
    pid = await mkProduct('a');
  });

  beforeEach(() => {
    delete process.env.CHECKOUT_REQUIRE_SHIPPING;
  });

  afterAll(async () => {
    if (originalFlag === undefined)
      delete process.env.CHECKOUT_REQUIRE_SHIPPING;
    else process.env.CHECKOUT_REQUIRE_SHIPPING = originalFlag;
    const holds = await prisma.stockHold.findMany({
      where: { productId: { in: productIds } },
    });
    await prisma.order.deleteMany({
      where: { lines: { some: { productId: { in: productIds } } } },
    });
    for (const h of holds) {
      await prisma.product.updateMany({
        where: { id: h.productId },
        data: { heldQty: 0 },
      });
    }
    await prisma.cart.deleteMany({
      where: {
        OR: [
          { customer: { email: { in: emails } } },
          { items: { some: { productId: { in: productIds } } } },
        ],
      },
    });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await prisma.shippingAgency.deleteMany({
      where: { id: { in: agencyIds } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await app.close();
  });

  describe('pickup (AC2)', () => {
    it('400 PICKUP_NOT_SUPPORTED, nothing created, cart untouched', async () => {
      const cookie = await guestCart();
      const before = await prisma.order.count({
        where: { lines: { some: { productId: pid } } },
      });
      const res = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', cookie)
        .send(flat({ fulfillmentType: 'pickup' }))
        .expect(400);
      expect((res.body as Err).errorCode).toBe('PICKUP_NOT_SUPPORTED');
      expect(
        await prisma.order.count({
          where: { lines: { some: { productId: pid } } },
        }),
      ).toBe(before);
      // the cart still checks out afterwards
      await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', cookie)
        .send(flat())
        .expect(201);
    });

    it('is rejected even with the flag on and with new-format fields', async () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      const res = await request(server())
        .post('/api/v1/checkout')
        .send(fresh({ fulfillmentType: 'pickup' }))
        .expect(400);
      expect((res.body as Err).errorCode).toBe('PICKUP_NOT_SUPPORTED');
    });
  });

  describe('flag CHECKOUT_REQUIRE_SHIPPING (AC6)', () => {
    it.each([undefined, 'false', '1', 'yes', ''])(
      'flat format accepted when flag is %j',
      async (v) => {
        if (v !== undefined) process.env.CHECKOUT_REQUIRE_SHIPPING = v;
        const res = await guestCheckout(flat()).then((r) => r);
        expect(res.status).toBe(201);
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: (res.body as Chk).orderId },
        });
        expect(o).toMatchObject({
          fulfillmentType: 'DELIVERY',
          city: 'Caracas',
          state: 'Distrito Capital',
          addressLine1: 'Av. Test 1',
          country: 'Venezuela',
          recipientIdDoc: null,
          deliveryMode: null,
          shippingAgencyId: null,
          municipality: null,
        });
      },
    );

    it('flat format -> 400 SHIPPING_REQUIRED when flag is exactly true (read per request)', async () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = ' True ';
      const res = await guestCheckout(flat()).then((r) => r);
      expect(res.status).toBe(400);
      expect((res.body as Err).errorCode).toBe('SHIPPING_REQUIRED');
      // flipping the env without restart takes effect on the next request
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'false';
      expect((await guestCheckout(flat())).status).toBe(201);
    });

    it('new format works with the flag on', async () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      expect((await guestCheckout(fresh())).status).toBe(201);
    });
  });

  describe('guest / explicit new format (AC5)', () => {
    it('creates the order with a normalized snapshot, city=municipality (A50)', async () => {
      const res = await guestCheckout(fresh({ paymentRail: 'stripe' }));
      expect(res.status).toBe(201);
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: (res.body as Chk).orderId },
      });
      expect(o).toMatchObject({
        fulfillmentType: 'DELIVERY',
        recipientName: 'Maria Perez',
        recipientPhone: '+584121234567',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'HOME_DELIVERY',
        shippingAgencyId: mrw.id,
        state: 'Miranda',
        municipality: 'Baruta',
        city: 'Baruta',
        parish: 'Las Minas',
        addressLine1: 'Calle 1, Casa 2',
        referencePoint: 'Frente a la plaza',
        country: 'Venezuela',
        customerId: null,
      });
    });

    it('400 SHIPPING_INVALID with details.errors (no values echoed)', async () => {
      const res = await guestCheckout(
        fresh({ recipientIdDoc: 'zzz', addressLine1: undefined }),
      );
      expect(res.status).toBe(400);
      const b = res.body as Err;
      expect(b.errorCode).toBe('SHIPPING_INVALID');
      expect(b.details?.errors).toEqual(
        expect.arrayContaining([
          { field: 'recipientIdDoc', code: 'INVALID' },
          { field: 'addressLine1', code: 'REQUIRED' },
        ]),
      );
      expect(JSON.stringify(res.body)).not.toContain('zzz');
    });

    it('400 SHIPPING_INVALID when recipient or agency are missing', async () => {
      const body = fresh({
        recipientName: undefined,
        shippingAgencyId: undefined,
      });
      const res = await guestCheckout(body);
      expect(res.status).toBe(400);
      expect((res.body as Err).errorCode).toBe('SHIPPING_INVALID');
      expect((res.body as Err).details?.errors).toEqual(
        expect.arrayContaining([
          { field: 'recipientName', code: 'REQUIRED' },
          { field: 'shippingAgencyId', code: 'REQUIRED' },
        ]),
      );
    });

    it('422 SHIPPING_AGENCY_UNAVAILABLE for unknown/malformed agency', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const res = await guestCheckout(fresh({ shippingAgencyId: id }));
        expect(res.status).toBe(422);
        expect((res.body as Err).errorCode).toBe('SHIPPING_AGENCY_UNAVAILABLE');
      }
    });

    it('422 SHIPPING_AGENCY_UNAVAILABLE for an inactive agency; the cart survives', async () => {
      const ag = await prisma.shippingAgency.create({
        data: {
          name: `Test ${tag}`,
          code: `TEST-${tag}`.toUpperCase(),
          isActive: false,
          allowsHomeDelivery: true,
          allowsOfficePickup: true,
        },
      });
      agencyIds.push(ag.id);
      const cookie = await guestCart();
      const res = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', cookie)
        .send(fresh({ shippingAgencyId: ag.id }));
      expect(res.status).toBe(422);
      expect((res.body as Err).errorCode).toBe('SHIPPING_AGENCY_UNAVAILABLE');
      await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', cookie)
        .send(fresh())
        .expect(201);
    });

    it('422 DELIVERY_MODE_NOT_ALLOWED when the agency lacks the mode', async () => {
      const ag = await prisma.shippingAgency.create({
        data: {
          name: `Office ${tag}`,
          code: `OFFICE-${tag}`.toUpperCase(),
          isActive: true,
          allowsHomeDelivery: false,
          allowsOfficePickup: true,
        },
      });
      agencyIds.push(ag.id);
      const res = await guestCheckout(
        fresh({ shippingAgencyId: ag.id, deliveryMode: 'home_delivery' }),
      );
      expect(res.status).toBe(422);
      expect((res.body as Err).errorCode).toBe('DELIVERY_MODE_NOT_ALLOWED');
    });

    it('agency_office requires the branch name', async () => {
      const res = await guestCheckout(
        fresh({ deliveryMode: 'agency_office', addressLine1: undefined }),
      );
      expect(res.status).toBe(400);
      expect((res.body as Err).details?.errors).toEqual(
        expect.arrayContaining([
          { field: 'agencyBranchName', code: 'REQUIRED' },
        ]),
      );
    });

    it('customerAddressId without a session -> 400 ADDRESS_REQUIRES_ACCOUNT', async () => {
      const res = await guestCheckout(
        fresh({ customerAddressId: randomUUID() }),
      );
      expect(res.status).toBe(400);
      expect((res.body as Err).errorCode).toBe('ADDRESS_REQUIRES_ACCOUNT');
    });
  });

  describe('account + customerAddressId (AC3/AC4)', () => {
    it('snapshots the saved address; later edit/delete does not change the order', async () => {
      const c = await customer('snap');
      const addrId = await mkAddr(c.id);
      const res = await accountCheckout(c.s, {
        paymentRail: 'pago_movil',
        customerAddressId: addrId,
      });
      expect(res.status).toBe(201);
      const id = (res.body as Chk).orderId;
      const expected = {
        customerId: c.id,
        fulfillmentType: 'DELIVERY',
        recipientName: 'Saved Name',
        recipientPhone: '04121234567',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'HOME_DELIVERY',
        shippingAgencyId: mrw.id,
        state: 'Miranda',
        municipality: 'Baruta',
        city: 'Baruta',
        parish: 'Las Minas',
        addressLine1: 'Saved line 1',
        addressLine2: 'Saved line 2',
        referencePoint: 'Saved ref',
        country: 'Venezuela',
      };
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject(expected);
      await prisma.customerAddress.update({
        where: { id: addrId },
        data: { recipientName: 'Changed', municipality: 'Chacao' },
      });
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject(expected);
      await prisma.customerAddress.delete({ where: { id: addrId } });
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject(expected);
    });

    it('the saved address prevails over contradictory body fields', async () => {
      const c = await customer('prev');
      const addrId = await mkAddr(c.id);
      const res = await accountCheckout(
        c.s,
        fresh({
          customerAddressId: addrId,
          shippingAgencyId: domesa.id,
          recipientName: 'Body Name',
          municipality: 'Body Muni',
          state: 'Body State',
          deliveryMode: 'agency_office',
          city: 'Body City',
        }),
      );
      expect(res.status).toBe(201);
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: (res.body as Chk).orderId },
      });
      expect(o).toMatchObject({
        recipientName: 'Saved Name',
        shippingAgencyId: mrw.id,
        municipality: 'Baruta',
        city: 'Baruta',
        state: 'Miranda',
        deliveryMode: 'HOME_DELIVERY',
      });
    });

    it("another customer's and nonexistent address -> identical 404 ADDRESS_NOT_FOUND", async () => {
      const a = await customer('owna');
      const b = await customer('ownb');
      const foreign = await mkAddr(b.id);
      const r1 = await accountCheckout(a.s, {
        paymentRail: 'pago_movil',
        customerAddressId: foreign,
      });
      // cart of `a` survived the failed attempt (same txn rolled back)
      const r2 = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', a.s)
        .send({ paymentRail: 'pago_movil', customerAddressId: randomUUID() });
      const r3 = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', a.s)
        .send({ paymentRail: 'pago_movil', customerAddressId: 'garbage' });
      for (const r of [r1, r2, r3]) {
        expect(r.status).toBe(404);
        expect((r.body as Err).errorCode).toBe('ADDRESS_NOT_FOUND');
      }
      expect(r1.body).toEqual(r2.body);
      expect(
        await prisma.order.count({
          where: { customerId: { in: [a.id, b.id] } },
        }),
      ).toBe(0);
    });

    it('a saved address whose agency was deactivated -> 422 (A52), no order', async () => {
      const ag = await prisma.shippingAgency.create({
        data: {
          name: `Gone ${tag}`,
          code: `GONE-${tag}`.toUpperCase(),
          isActive: true,
          allowsHomeDelivery: true,
          allowsOfficePickup: true,
        },
      });
      agencyIds.push(ag.id);
      const c = await customer('inact');
      const addrId = await mkAddr(c.id, { agencyId: ag.id });
      await prisma.shippingAgency.update({
        where: { id: ag.id },
        data: { isActive: false },
      });
      const res = await accountCheckout(c.s, {
        paymentRail: 'pago_movil',
        customerAddressId: addrId,
      });
      expect(res.status).toBe(422);
      expect((res.body as Err).errorCode).toBe('SHIPPING_AGENCY_UNAVAILABLE');
      expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0);
    });

    it('works for the stripe rail too', async () => {
      const c = await customer('stripe');
      const addrId = await mkAddr(c.id);
      const res = await accountCheckout(c.s, {
        paymentRail: 'stripe',
        customerAddressId: addrId,
      });
      expect(res.status).toBe(201);
    });

    it('account without customerAddressId can send the explicit new format', async () => {
      const c = await customer('expl');
      const res = await accountCheckout(c.s, fresh());
      expect(res.status).toBe(201);
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: (res.body as Chk).orderId },
      });
      expect(o.customerId).toBe(c.id);
      expect(o.city).toBe('Baruta');
    });

    it('lesson 12.5: an anonymous cart cookie is never used for an account order', async () => {
      const c = await customer('anon');
      const addrId = await mkAddr(c.id);
      const anon = await guestCart();
      const res = await request(server())
        .post('/api/v1/checkout')
        .set('Cookie', [anon, c.s])
        .send({ paymentRail: 'pago_movil', customerAddressId: addrId });
      expect(res.status).toBe(422);
      expect((res.body as Err).errorCode).toBe('EMPTY_CART');
      expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0);
    });
  });
});
