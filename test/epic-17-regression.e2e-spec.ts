import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const PASSWORD = 'Correct-horse-17-6!';
const SEEDED = ['MRW', 'ZOOM', 'TEALCA', 'DOMESA'];
interface Err {
  errorCode: string;
}
interface Addr {
  id: string;
  isDefault: boolean;
  recipientIdDoc: string;
}
interface View {
  fulfillment?: Record<string, unknown>;
}

/**
 * Story 17.6 (PRD 18.5, AD-77): smoke of the whole Epic 17 flow. Real Postgres.
 * Own admin/customers/product/agency/orders are removed afterwards; the 4
 * seeded agencies are snapshotted and restored; CHECKOUT_REQUIRE_SHIPPING is
 * restored. The real orders are never touched. Detailed edge cases live in
 * shipping-agencies / customer-addresses* / checkout-shipping / order-tracking.
 */
describe('Epic 17 regression (e2e, Story 17.6)', { timeout: 60000 }, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tag = randomUUID().slice(0, 8);
  const originalFlag = process.env.CHECKOUT_REQUIRE_SHIPPING;
  const adminUser = `e2e-17-6-${tag}`;
  let adminId: string;
  let token: string;
  let snapshot: Awaited<
    ReturnType<PrismaService['shippingAgency']['findMany']>
  >;
  let categoryId: string;
  let productId: string;
  let agency: { id: string; code: string };
  const customerIds: string[] = [];
  const emails: string[] = [];
  const orderIds: string[] = [];
  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const TPL1 = 'https://old.track.test/{trackingNumber}';
  const TPL2 = 'https://track.test/{trackingNumber}/x';

  const cookieOf = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  async function customer(k: string): Promise<{ id: string; s: string }> {
    const email = `e2e-17-6-${k}-${tag}@212collectorsclub.test`;
    emails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Epic17 Tester' })
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
    agencyId: agency.id,
    deliveryMode: 'home_delivery',
    recipientName: 'Maria Perez',
    recipientPhone: '+58 (412) 123-4567',
    recipientIdDoc: 'v12345678',
    state: 'Miranda',
    municipality: 'Baruta',
    addressLine1: 'Calle 1, Casa 2',
    ...over,
  });
  const postAddr = (s: string, b: object) =>
    request(server()).post('/api/v1/auth/addresses').set('Cookie', s).send(b);
  const listAddr = async (s: string): Promise<Addr[]> =>
    (
      (
        await request(server())
          .get('/api/v1/auth/addresses')
          .set('Cookie', s)
          .expect(200)
      ).body as { data: Addr[] }
    ).data;

  async function cartCheckout(s: string | null, body: object) {
    const add = request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity: 1 });
    if (s) void add.set('Cookie', s);
    const added = await add.expect(201);
    const cookie = s ?? cookieOf(added, 'cartId');
    return request(server())
      .post('/api/v1/checkout')
      .set('Cookie', cookie)
      .send(body);
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
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    delete process.env.CHECKOUT_REQUIRE_SHIPPING;

    snapshot = await prisma.shippingAgency.findMany({
      where: { code: { in: SEEDED } },
    });
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    productId = (
      await prisma.product.create({
        data: {
          name: `E17 ${tag}`,
          slug: `e17-${tag}`,
          description: 'Created by e2e 17.6.',
          franchise: 'NARUTO',
          productType: 'BOOSTER_BOX',
          rarity: 'COMMON',
          priceUsd: '5.00',
          stock: 100,
          heldQty: 0,
          isActive: true,
          categoryId,
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
  });

  afterAll(async () => {
    if (originalFlag === undefined)
      delete process.env.CHECKOUT_REQUIRE_SHIPPING;
    else process.env.CHECKOUT_REQUIRE_SHIPPING = originalFlag;
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
    await prisma.shippingAgency.deleteMany({
      where: { code: { startsWith: `E17-${tag}`.toUpperCase() } },
    });
    for (const row of snapshot) {
      const { id, createdAt, ...rest } = row;
      void createdAt;
      await prisma.shippingAgency.update({ where: { id }, data: rest });
    }
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('seeded agencies: 4 present, public list is active-only, ordered, without trackingUrlTemplate', async () => {
    expect(snapshot.map((a) => a.code).sort()).toEqual([...SEEDED].sort());
    const res = await request(server())
      .get('/api/v1/shipping/agencies')
      .expect(200);
    const rows = (res.body as { data: { code: string; sortOrder?: number }[] })
      .data;
    expect(rows.map((r) => r.code).filter((c) => SEEDED.includes(c))).toEqual(
      SEEDED,
    );
    expect(JSON.stringify(res.body)).not.toContain('trackingUrlTemplate');
  });

  it('admin creates an agency with a template, edits it, and the inactive one leaves the public list', async () => {
    const code = `e17-${tag}`;
    const created = await request(server())
      .post('/api/v1/admin/shipping/agencies')
      .set(auth())
      .send({ name: `E17 ${tag}`, code, trackingUrlTemplate: TPL1 })
      .expect(201);
    agency = created.body as { id: string; code: string };
    expect(agency.code).toBe(code.toUpperCase());
    const edited = await request(server())
      .patch(`/api/v1/admin/shipping/agencies/${agency.id}`)
      .set(auth())
      .send({ trackingUrlTemplate: TPL2, sortOrder: 900 })
      .expect(200);
    expect(edited.body).toMatchObject({ trackingUrlTemplate: TPL2 });

    const pub = async () =>
      (
        (await request(server()).get('/api/v1/shipping/agencies').expect(200))
          .body as { data: { id: string }[] }
      ).data;
    expect((await pub()).some((a) => a.id === agency.id)).toBe(true);
    await request(server())
      .patch(`/api/v1/admin/shipping/agencies/${agency.id}`)
      .set(auth())
      .send({ isActive: false })
      .expect(200);
    expect((await pub()).some((a) => a.id === agency.id)).toBe(false);
    await request(server())
      .patch(`/api/v1/admin/shipping/agencies/${agency.id}`)
      .set(auth())
      .send({ isActive: true })
      .expect(200);
  });

  describe('address book', () => {
    let a: { id: string; s: string };
    let b: { id: string; s: string };

    it('normalizes the cedula, first address is default, a second default is impossible', async () => {
      a = await customer('a');
      b = await customer('b');
      const first = (await postAddr(a.s, addrBody()).expect(201)).body as Addr;
      expect(first).toMatchObject({
        recipientIdDoc: 'V-12345678',
        isDefault: true,
      });
      const second = (
        await postAddr(a.s, addrBody({ label: 'Segunda' })).expect(201)
      ).body as Addr;
      expect(second.isDefault).toBe(false);
      await expect(
        prisma.customerAddress.update({
          where: { id: second.id },
          data: { isDefault: true },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.customerAddress.count({
          where: { customerId: a.id, isDefault: true },
        }),
      ).toBe(1);
    });

    it('rejects invalid cedulas and Domesa + home_delivery', async () => {
      for (const doc of ['X-1', 'V-12']) {
        const r = await postAddr(a.s, addrBody({ recipientIdDoc: doc }));
        expect(r.status).toBe(400);
        expect((r.body as Err).errorCode).toBe('SHIPPING_INVALID');
      }
      const domesa = snapshot.find((s) => s.code === 'DOMESA')!;
      const r = await postAddr(a.s, addrBody({ agencyId: domesa.id }));
      expect(r.status).toBe(422);
      expect((r.body as Err).errorCode).toBe('DELIVERY_MODE_NOT_ALLOWED');
    });

    it('isolates customers (404 ADDRESS_NOT_FOUND), changes the default and promotes the most recent on delete', async () => {
      const rows = await listAddr(a.s);
      expect(rows).toHaveLength(2);
      expect(await listAddr(b.s)).toEqual([]);
      const [def, other] = [
        rows.find((r) => r.isDefault)!,
        rows.find((r) => !r.isDefault)!,
      ];
      const foreign = await request(server())
        .patch(`/api/v1/auth/addresses/${def.id}/set-default`)
        .set('Cookie', b.s);
      expect(foreign.status).toBe(404);
      expect((foreign.body as Err).errorCode).toBe('ADDRESS_NOT_FOUND');
      await request(server())
        .delete(`/api/v1/auth/addresses/${def.id}`)
        .set('Cookie', b.s)
        .expect(404);

      await request(server())
        .patch(`/api/v1/auth/addresses/${other.id}/set-default`)
        .set('Cookie', a.s)
        .expect(200);
      expect(
        (await listAddr(a.s)).filter((r) => r.isDefault).map((r) => r.id),
      ).toEqual([other.id]);

      // third (most recent), then delete the default: the newest remaining wins
      const third = (await postAddr(a.s, addrBody()).expect(201)).body as Addr;
      await request(server())
        .delete(`/api/v1/auth/addresses/${other.id}`)
        .set('Cookie', a.s)
        .expect(204);
      const after = await listAddr(a.s);
      expect(after.filter((r) => r.isDefault).map((r) => r.id)).toEqual([
        third.id,
      ]);
    });
  });

  describe('checkout, tracking and views', () => {
    it('customerAddressId with the flag on: immutable snapshot; foreign address 404; tracking number shows trackingUrl in customer and lookup views', async () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      const c = await customer('buyer');
      const other = await customer('other');
      const addr = (await postAddr(c.s, addrBody()).expect(201)).body as Addr;
      const foreignAddr = (await postAddr(other.s, addrBody()).expect(201))
        .body as Addr;

      const bad = await cartCheckout(c.s, {
        paymentRail: 'pago_movil',
        customerAddressId: foreignAddr.id,
      });
      expect(bad.status).toBe(404);
      expect((bad.body as Err).errorCode).toBe('ADDRESS_NOT_FOUND');

      const res = await cartCheckout(c.s, {
        paymentRail: 'pago_movil',
        customerAddressId: addr.id,
      });
      expect(res.status).toBe(201);
      const { orderId, orderAccessToken } = res.body as {
        orderId: string;
        orderAccessToken: string;
      };
      orderIds.push(orderId);
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      ).toMatchObject({
        shippingAgencyId: agency.id,
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'HOME_DELIVERY',
        municipality: 'Baruta',
        city: 'Baruta',
      });

      // the snapshot survives editing and deleting the saved address
      await request(server())
        .patch(`/api/v1/auth/addresses/${addr.id}`)
        .set('Cookie', c.s)
        .send({ municipality: 'Chacao' })
        .expect(200);
      await request(server())
        .delete(`/api/v1/auth/addresses/${addr.id}`)
        .set('Cookie', c.s)
        .expect(204);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .municipality,
      ).toBe('Baruta');

      // no guide yet: trackingUrl is null
      const own = () =>
        request(server())
          .get(`/api/v1/auth/orders/${orderId}`)
          .set('Cookie', c.s)
          .expect(200);
      const lookup = () =>
        request(server())
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${orderAccessToken}`)
          .expect(200);
      expect(((await own()).body as View).fulfillment).toMatchObject({
        trackingNumber: null,
        trackingUrl: null,
      });

      // admin loads the guide
      const set = await request(server())
        .patch(`/api/v1/admin/orders/${orderId}/tracking`)
        .set(auth())
        .send({ trackingNumber: 'AB-123' })
        .expect(200);
      expect(set.body).toEqual({
        orderId,
        trackingNumber: 'AB-123',
        trackingUrl: 'https://track.test/AB-123/x',
      });
      for (const v of [await own(), await lookup()]) {
        const body = v.body as View;
        expect(body.fulfillment).toMatchObject({
          trackingNumber: 'AB-123',
          trackingUrl: 'https://track.test/AB-123/x',
          shippingAgency: { code: agency.code },
          recipientIdDoc: 'V-12345678',
        });
        expect(JSON.stringify(body)).not.toContain('trackingUrlTemplate');
      }
    });

    it('guest flat format: 201 with flag false, 400 SHIPPING_REQUIRED with true; pickup is 400 PICKUP_NOT_SUPPORTED', async () => {
      const flat = {
        paymentRail: 'pago_movil',
        fulfillmentType: 'delivery',
        recipientName: 'Maria Perez',
        recipientPhone: '0412-1234567',
        addressLine1: 'Av. Test 1',
        city: 'Caracas',
        state: 'Distrito Capital',
      };
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'false';
      const ok = await cartCheckout(null, flat);
      expect(ok.status).toBe(201);
      orderIds.push((ok.body as { orderId: string }).orderId);

      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      const no = await cartCheckout(null, flat);
      expect(no.status).toBe(400);
      expect((no.body as Err).errorCode).toBe('SHIPPING_REQUIRED');

      delete process.env.CHECKOUT_REQUIRE_SHIPPING;
      const pick = await cartCheckout(null, {
        ...flat,
        fulfillmentType: 'pickup',
      });
      expect(pick.status).toBe(400);
      expect((pick.body as Err).errorCode).toBe('PICKUP_NOT_SUPPORTED');
    });

    it('historical pickup order stays readable (200) in the three views with null shipping fields', async () => {
      const c = await customer('hist');
      const raw = randomBytes(32).toString('hex');
      const o = await prisma.order.create({
        data: {
          status: 'PAID',
          paymentRail: 'PAGO_MOVIL',
          fulfillmentType: 'PICKUP',
          recipientName: 'Historic',
          recipientPhone: '04120000000',
          totalUsd: '5.00' as never,
          accessTokenHash: createHash('sha256').update(raw).digest('hex'),
          customerId: c.id,
          lines: {
            create: [
              {
                productId,
                productName: 'x',
                unitPriceUsd: '5.00' as never,
                quantity: 1,
                lineTotalUsd: '5.00' as never,
              },
            ],
          },
        } as never,
      });
      orderIds.push(o.id);
      const views = [
        await request(server())
          .get(`/api/v1/orders/${o.id}`)
          .set('Authorization', `Bearer ${raw}`),
        await request(server())
          .get(`/api/v1/auth/orders/${o.id}`)
          .set('Cookie', c.s),
        await request(server()).get(`/api/v1/admin/orders/${o.id}`).set(auth()),
      ];
      for (const v of views) {
        expect(v.status).toBe(200);
        expect((v.body as View).fulfillment).toMatchObject({
          type: 'pickup',
          deliveryMode: null,
          shippingAgency: null,
          trackingNumber: null,
          trackingUrl: null,
        });
      }
    });
  });

  it('left the 4 seeded agencies untouched', async () => {
    const now = await prisma.shippingAgency.findMany({
      where: { code: { in: SEEDED } },
    });
    expect(
      now.map((a) => [a.id, a.trackingUrlTemplate, a.isActive]).sort(),
    ).toEqual(
      snapshot.map((a) => [a.id, a.trackingUrlTemplate, a.isActive]).sort(),
    );
  });
});
