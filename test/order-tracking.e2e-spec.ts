import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];
interface Body {
  [k: string]: unknown;
  fulfillment?: Record<string, unknown>;
  data?: { fulfillment: Record<string, unknown> }[];
  errorCode?: string;
}

const TAG = randomUUID().slice(0, 8);
const ADMIN_USER = `e2e-admin-17-5-${TAG}`;
const ADMIN_EMAIL = `${ADMIN_USER}@212collectorsclub.test`;
const ADMIN_PASSWORD = 'correct-horse-battery-staple-17-5';
const PASSWORD = 'correct-horse-battery-17-5';
const OP_ROMANCE_DAWN_ID = '4b904156-c25d-48ad-818e-b2e78224df97';
const TEMPLATE = 'https://track.test/{trackingNumber}/x';

/**
 * Story 17.5 (FR-88/89, AD-75/76). Real Postgres. Uses its own agencies,
 * customer, admin and orders (all removed in afterAll); the seeded agencies
 * and real orders are never touched.
 */
describe('Order shipping exposure + tracking (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let agencyWithTpl: string;
  let agencyNoTpl: string;
  let customerId: string;
  let session: string;
  const orderIds: string[] = [];
  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function mkOrder(
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; raw: string }> {
    const raw = randomBytes(32).toString('hex');
    const o = await prisma.order.create({
      data: {
        status: 'PAID',
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'PICKUP',
        recipientName: 'Track Tester',
        recipientPhone: '04120000000',
        totalUsd: '10.00' as never,
        accessTokenHash: createHash('sha256').update(raw).digest('hex'),
        customerId,
        lines: {
          create: [
            {
              productId: OP_ROMANCE_DAWN_ID,
              productName: 'x',
              unitPriceUsd: '10.00' as never,
              quantity: 1,
              lineTotalUsd: '10.00' as never,
            },
          ],
        },
        ...over,
      } as never,
    });
    orderIds.push(o.id);
    return { id: o.id, raw };
  }
  const shipped = (agencyId: string, extra: Record<string, unknown> = {}) => ({
    fulfillmentType: 'DELIVERY',
    recipientIdDoc: 'V-12345678',
    deliveryMode: 'AGENCY_OFFICE',
    shippingAgencyId: agencyId,
    agencyBranchName: 'Sucursal Test',
    agencyBranchCode: 'ST-1',
    municipality: 'Baruta',
    parish: 'Las Minas',
    referencePoint: 'Cerca',
    state: 'Miranda',
    city: 'Baruta',
    addressLine1: 'Calle 1',
    country: 'Venezuela',
    ...extra,
  });
  const patch = (id: string, b: unknown) =>
    request(server())
      .patch(`/api/v1/admin/orders/${id}/tracking`)
      .set(auth())
      .send(b as object);

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = mod.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    agencyWithTpl = (
      await prisma.shippingAgency.create({
        data: {
          name: 'Test Tpl',
          code: `TEST-TPL-${TAG}`,
          trackingUrlTemplate: TEMPLATE,
          sortOrder: 900,
        },
      })
    ).id;
    agencyNoTpl = (
      await prisma.shippingAgency.create({
        data: { name: 'Test NoTpl', code: `TEST-NOTPL-${TAG}`, sortOrder: 901 },
      })
    ).id;

    const hash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
    adminId = (
      await prisma.adminUser.create({
        data: { username: ADMIN_USER, email: ADMIN_EMAIL, passwordHash: hash },
      })
    ).id;
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    const email = `e2e-17-5-${TAG}@212collectorsclub.test`;
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Track Tester' })
      .expect(201);
    customerId = (
      await prisma.customer.update({
        where: { email },
        data: { emailVerified: true },
      })
    ).id;
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    session = (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('cc_session='))!
      .split(';')[0];
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.shippingAgency.deleteMany({
      where: { id: { in: [agencyWithTpl, agencyNoTpl] } },
    });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('historical pickup order: 200 in the three views with new fields null', async () => {
    const { id, raw } = await mkOrder();
    const nulls = [
      'recipientIdDoc',
      'deliveryMode',
      'agencyBranchName',
      'agencyBranchCode',
      'municipality',
      'parish',
      'referencePoint',
      'shippingAgency',
      'trackingNumber',
      'trackingUrl',
    ];
    const check = (f: Record<string, unknown>) => {
      expect(f.type).toBe('pickup');
      for (const k of nulls) expect(f[k]).toBeNull();
    };
    const pub = await request(server())
      .get(`/api/v1/orders/${id}`)
      .set('Authorization', `Bearer ${raw}`);
    expect(pub.status).toBe(200);
    check((pub.body as Body).fulfillment!);
    const one = await request(server())
      .get(`/api/v1/auth/orders/${id}`)
      .set('Cookie', session)
      .expect(200);
    check((one.body as Body).fulfillment!);
    const adm = await request(server())
      .get(`/api/v1/admin/orders/${id}`)
      .set(auth())
      .expect(200);
    check((adm.body as Body).fulfillment!);
  });

  it('shipped order exposes snapshot + trackingUrl in the 3 views; template never leaks', async () => {
    const { id, raw } = await mkOrder(
      shipped(agencyWithTpl, { trackingNumber: 'AB/12 3' }),
    );
    const expectedUrl = 'https://track.test/AB%2F12%203/x';
    const check = (f: Record<string, unknown>) => {
      expect(f).toMatchObject({
        type: 'delivery',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'agency_office',
        agencyBranchName: 'Sucursal Test',
        agencyBranchCode: 'ST-1',
        municipality: 'Baruta',
        parish: 'Las Minas',
        referencePoint: 'Cerca',
        shippingAgency: { name: 'Test Tpl', code: `TEST-TPL-${TAG}` },
        trackingNumber: 'AB/12 3',
        trackingUrl: expectedUrl,
      });
    };
    const pub = await request(server())
      .get(`/api/v1/orders/${id}`)
      .set('Authorization', `Bearer ${raw}`)
      .expect(200);
    check((pub.body as Body).fulfillment!);
    expect(JSON.stringify(pub.body)).not.toContain('trackingUrlTemplate');
    expect(JSON.stringify(pub.body)).not.toContain('track.test/{');
    const list = await request(server())
      .get('/api/v1/auth/orders')
      .set('Cookie', session)
      .expect(200);
    const row = (list.body as Body).data!.find(
      (d) => (d as unknown as { orderId: string }).orderId === id,
    )!;
    check(row.fulfillment);
    const one = await request(server())
      .get(`/api/v1/auth/orders/${id}`)
      .set('Cookie', session)
      .expect(200);
    check((one.body as Body).fulfillment!);
    const adm = await request(server())
      .get(`/api/v1/admin/orders/${id}`)
      .set(auth())
      .expect(200);
    check((adm.body as Body).fulfillment!);
  });

  it('trackingUrl is null without number or without agency template', async () => {
    const a = await mkOrder(shipped(agencyWithTpl));
    const b = await mkOrder(shipped(agencyNoTpl, { trackingNumber: 'ZZ-123' }));
    for (const id of [a.id, b.id]) {
      const r = await request(server())
        .get(`/api/v1/admin/orders/${id}`)
        .set(auth())
        .expect(200);
      expect(
        ((r.body as Body).fulfillment as Record<string, unknown>).trackingUrl,
      ).toBeNull();
    }
  });

  describe('PATCH /admin/orders/:id/tracking', () => {
    it('401 without token, 404 unknown order, 400 bad uuid', async () => {
      const { id } = await mkOrder();
      await request(server())
        .patch(`/api/v1/admin/orders/${id}/tracking`)
        .send({ trackingNumber: 'ABC123' })
        .expect(401);
      const r = await patch(randomUUID(), { trackingNumber: 'ABC123' });
      expect(r.status).toBe(404);
      expect((r.body as Body).errorCode).toBe('ORDER_NOT_FOUND');
      await patch('nope', { trackingNumber: 'ABC123' }).expect(400);
    });

    it.each([
      ['too short', 'ab'],
      ['bad chars', 'AB C#1'],
      ['too long', 'A'.repeat(65)],
      ['number', 12345],
    ])('400 TRACKING_NUMBER_INVALID: %s', async (_n, v) => {
      const { id } = await mkOrder();
      const r = await patch(id, { trackingNumber: v });
      expect(r.status).toBe(400);
      expect((r.body as Body).errorCode).toBe('TRACKING_NUMBER_INVALID');
    });

    it('400 on missing key and unknown field (strictBody)', async () => {
      const { id } = await mkOrder();
      expect((await patch(id, {})).status).toBe(400);
      expect(
        (await patch(id, { trackingNumber: 'ABC123', foo: 1 })).status,
      ).toBe(400);
    });

    it('sets, is idempotent, changes and clears with audit events; status untouched', async () => {
      const { id } = await mkOrder(shipped(agencyWithTpl));
      const events = () =>
        prisma.orderTrackingEvent.findMany({
          where: { orderId: id },
          orderBy: { createdAt: 'asc' },
        });

      const r1 = await patch(id, { trackingNumber: '  ABC-123  ' }).expect(200);
      expect(r1.body).toEqual({
        orderId: id,
        trackingNumber: 'ABC-123',
        trackingUrl: 'https://track.test/ABC-123/x',
      });
      await patch(id, { trackingNumber: 'ABC-123' }).expect(200);
      expect(await events()).toHaveLength(1);

      await patch(id, { trackingNumber: 'XYZ/9' }).expect(200);
      const r3 = await patch(id, { trackingNumber: null }).expect(200);
      expect(r3.body).toEqual({
        orderId: id,
        trackingNumber: null,
        trackingUrl: null,
      });
      // "" on an already-cleared order is a no-op
      await patch(id, { trackingNumber: '' }).expect(200);

      const ev = await events();
      expect(ev.map((e) => [e.previousValue, e.newValue])).toEqual([
        [null, 'ABC-123'],
        ['ABC-123', 'XYZ/9'],
        ['XYZ/9', null],
      ]);
      expect(ev.every((e) => e.adminUserId === adminId)).toBe(true);

      const o = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(o.status).toBe('PAID');
      expect(o.trackingNumber).toBeNull();
    });

    it('works on terminal states and orders without agency (url null)', async () => {
      const { id } = await mkOrder({ status: 'CANCELLED' });
      const r = await patch(id, { trackingNumber: 'LATE-001' }).expect(200);
      expect((r.body as Body).trackingUrl).toBeNull();
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('CANCELLED');
    });
  });
});
