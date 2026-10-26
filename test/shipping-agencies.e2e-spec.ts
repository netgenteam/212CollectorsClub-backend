import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

const TEST_USERNAME = 'e2e-admin-story-17-1';
const TEST_EMAIL = 'e2e-admin-story-17-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-17-1';
const PUBLIC = '/api/v1/shipping/agencies';
const ADMIN = '/api/v1/admin/shipping/agencies';
const SEEDED_CODES = ['MRW', 'ZOOM', 'TEALCA', 'DOMESA'];

interface AgencyBody {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
  trackingUrlTemplate?: string | null;
  allowsOfficePickup: boolean;
  allowsHomeDelivery: boolean;
}

/**
 * Story 17.1 (FR-82/83, AD-70/71). Real Postgres. The 4 seeded agencies are
 * snapshotted before and restored after (including any admin edits); the
 * extra agency / customers created here use unique ids and are removed.
 */
describe('Shipping agencies (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let token: string;
  let snapshot: Awaited<
    ReturnType<PrismaService['shippingAgency']['findMany']>
  >;
  const extraAgencyIds: string[] = [];
  const customerIds: string[] = [];

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const seeded = async (code: string) =>
    prisma.shippingAgency.findUniqueOrThrow({ where: { code } });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    snapshot = await prisma.shippingAgency.findMany({
      where: { code: { in: SEEDED_CODES } },
    });
    expect(snapshot).toHaveLength(4);

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.shippingAgency.deleteMany({
      where: { id: { in: extraAgencyIds } },
    });
    // Restore the seeded rows exactly as they were.
    for (const row of snapshot) {
      const { id, code, createdAt, ...rest } = row;
      void createdAt;
      await prisma.shippingAgency.update({
        where: { id },
        data: { ...rest, code },
      });
    }
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  afterEach(async () => {
    // Keep every test independent of PATCH side effects.
    for (const row of snapshot) {
      const { id, code, createdAt, updatedAt, ...rest } = row;
      void createdAt;
      void updatedAt;
      await prisma.shippingAgency.update({
        where: { id },
        data: { ...rest, code },
      });
    }
  });

  describe('GET /shipping/agencies (public)', () => {
    it('lists only active agencies in sortOrder with the public shape and cache header', async () => {
      const extra = await prisma.shippingAgency.create({
        data: {
          name: 'Inactive',
          code: `t-${randomUUID().slice(0, 12)}`,
          isActive: false,
          sortOrder: 99,
        },
      });
      extraAgencyIds.push(extra.id);

      const res = await server().get(PUBLIC).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const rows = (res.body as { data: AgencyBody[] }).data;
      const ours = rows.filter((r) => SEEDED_CODES.includes(r.code));
      expect(ours.map((r) => r.code)).toEqual(SEEDED_CODES);
      expect(rows.find((r) => r.id === extra.id)).toBeUndefined();
      expect(Object.keys(ours[0]).sort()).toEqual([
        'allowsHomeDelivery',
        'allowsOfficePickup',
        'code',
        'id',
        'name',
      ]);
      const domesa = ours.find((r) => r.code === 'DOMESA')!;
      expect(domesa.allowsHomeDelivery).toBe(false);
      expect(domesa.allowsOfficePickup).toBe(true);
    });

    it('seeded agencies have no trackingUrlTemplate by default', async () => {
      const domesa = await seeded('DOMESA');
      expect(domesa.trackingUrlTemplate).toBeNull();
    });
  });

  describe('GET /admin/shipping/agencies', () => {
    it('401 without token', async () => {
      await server().get(ADMIN).expect(401);
    });

    it('lists all agencies with admin fields', async () => {
      const res = await server().get(ADMIN).set(auth()).expect(200);
      const rows = (res.body as { data: AgencyBody[] }).data;
      for (const code of SEEDED_CODES) {
        const row = rows.find((r) => r.code === code);
        expect(row).toBeDefined();
        expect(row).toHaveProperty('isActive');
        expect(row).toHaveProperty('trackingUrlTemplate');
      }
    });
  });

  describe('PATCH /admin/shipping/agencies/:id', () => {
    it('401 without token', async () => {
      const mrw = await seeded('MRW');
      await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .send({ name: 'X' })
        .expect(401);
    });

    it('edits fields and sets/clears the tracking template', async () => {
      const mrw = await seeded('MRW');
      const tpl = 'https://tracking.test/t?n={trackingNumber}';
      const ok = await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .set(auth())
        .send({ name: 'MRW Edit', sortOrder: 7, trackingUrlTemplate: tpl })
        .expect(200);
      expect(ok.body).toMatchObject({
        name: 'MRW Edit',
        sortOrder: 7,
        trackingUrlTemplate: tpl,
      });
      const cleared = await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .set(auth())
        .send({ trackingUrlTemplate: null })
        .expect(200);
      expect((cleared.body as AgencyBody).trackingUrlTemplate).toBeNull();
    });

    it('deactivated agency disappears from the public list', async () => {
      const zoom = await seeded('ZOOM');
      await server()
        .patch(`${ADMIN}/${zoom.id}`)
        .set(auth())
        .send({ isActive: false })
        .expect(200);
      const res = await server().get(PUBLIC).expect(200);
      expect(
        (res.body as { data: AgencyBody[] }).data.some((r) => r.id === zoom.id),
      ).toBe(false);
    });

    it('404 SHIPPING_AGENCY_NOT_FOUND for unknown and non-uuid ids', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const res = await server()
          .patch(`${ADMIN}/${id}`)
          .set(auth())
          .send({ name: 'X' })
          .expect(404);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'SHIPPING_AGENCY_NOT_FOUND',
        );
      }
    });

    it.each([
      'http://tracking.test/{trackingNumber}',
      'https://tracking.test/no-marker',
      'https://tracking.test/{trackingNumber}/{trackingNumber}',
    ])('400 TRACKING_TEMPLATE_INVALID for %s', async (tpl) => {
      const mrw = await seeded('MRW');
      const res = await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .set(auth())
        .send({ trackingUrlTemplate: tpl })
        .expect(400);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'TRACKING_TEMPLATE_INVALID',
      );
    });

    it('400 for unknown fields (strictBody) and empty body', async () => {
      const mrw = await seeded('MRW');
      await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .set(auth())
        .send({ code: 'hacked' })
        .expect(400);
      await server()
        .patch(`${ADMIN}/${mrw.id}`)
        .set(auth())
        .send({})
        .expect(400);
      expect((await seeded('MRW')).code).toBe('MRW');
    });

    it('422 AGENCY_WITHOUT_DELIVERY_MODE when an active agency allows nothing', async () => {
      const domesa = await seeded('DOMESA');
      const res = await server()
        .patch(`${ADMIN}/${domesa.id}`)
        .set(auth())
        .send({ allowsOfficePickup: false })
        .expect(422);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'AGENCY_WITHOUT_DELIVERY_MODE',
      );
      expect((await seeded('DOMESA')).allowsOfficePickup).toBe(true);
    });
  });

  describe('POST /admin/shipping/agencies', () => {
    const uniq = () => `E2E171_${randomUUID().slice(0, 8).toUpperCase()}`;
    const track = (id: string): void => {
      extraAgencyIds.push(id);
    };

    it('401 without token', async () => {
      await server().post(ADMIN).send({ name: 'X', code: uniq() }).expect(401);
    });

    it('creates (201), upper-cases the code and lists it publicly', async () => {
      const code = uniq();
      const res = await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'Nueva', code: ` ${code.toLowerCase()} `, sortOrder: 50 })
        .expect(201);
      const body = res.body as AgencyBody;
      track(body.id);
      expect(body).toMatchObject({
        name: 'Nueva',
        code,
        isActive: true,
        allowsOfficePickup: true,
        allowsHomeDelivery: true,
        trackingUrlTemplate: null,
      });
      const pub = await server().get(PUBLIC).expect(200);
      expect(
        (pub.body as { data: AgencyBody[] }).data.some((r) => r.code === code),
      ).toBe(true);
    });

    it('400 invalid code / unknown field / bad template; 422 without modes', async () => {
      for (const body of [
        { name: 'X', code: 'a' },
        { name: 'X', code: 'bad code!' },
        { name: 'X', code: uniq(), extra: 1 },
        { name: '', code: uniq() },
      ]) {
        await server().post(ADMIN).set(auth()).send(body).expect(400);
      }
      const bad = await server()
        .post(ADMIN)
        .set(auth())
        .send({
          name: 'X',
          code: uniq(),
          trackingUrlTemplate: 'http://x/{trackingNumber}',
        })
        .expect(400);
      expect((bad.body as { errorCode: string }).errorCode).toBe(
        'TRACKING_TEMPLATE_INVALID',
      );
      const none = await server()
        .post(ADMIN)
        .set(auth())
        .send({
          name: 'X',
          code: uniq(),
          allowsOfficePickup: false,
          allowsHomeDelivery: false,
        })
        .expect(422);
      expect((none.body as { errorCode: string }).errorCode).toBe(
        'AGENCY_WITHOUT_DELIVERY_MODE',
      );
    });

    it('409 SHIPPING_AGENCY_CODE_TAKEN on duplicate code', async () => {
      const code = uniq();
      const first = await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'A', code })
        .expect(201);
      track((first.body as AgencyBody).id);
      const dup = await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'B', code })
        .expect(409);
      expect((dup.body as { errorCode: string }).errorCode).toBe(
        'SHIPPING_AGENCY_CODE_TAKEN',
      );
    });

    it('seeded codes already match the normalized (upper-case) form', async () => {
      const rows = await prisma.shippingAgency.findMany({
        where: { code: { in: SEEDED_CODES } },
      });
      expect(rows).toHaveLength(4);
      for (const r of rows) expect(r.code).toMatch(/^[A-Z0-9_-]{2,50}$/);
      expect(
        await prisma.shippingAgency.count({
          where: { code: { in: ['mrw', 'zoom', 'tealca', 'domesa'] } },
        }),
      ).toBe(0);
    });

    it('409 for a seeded code in any case (POST code=mrw collides with MRW)', async () => {
      for (const code of ['mrw', 'MRW', ' Mrw ']) {
        const res = await server()
          .post(ADMIN)
          .set(auth())
          .send({ name: 'x', code })
          .expect(409);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'SHIPPING_AGENCY_CODE_TAKEN',
        );
      }
    });

    it('accepts a 50-char code (201) and rejects 51 (400)', async () => {
      const code = `E${randomUUID().replace(/-/g, '').toUpperCase()}`.padEnd(
        50,
        'X',
      );
      expect(code).toHaveLength(50);
      const ok = await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'Long', code })
        .expect(201);
      track((ok.body as AgencyBody).id);
      expect((ok.body as AgencyBody).code).toBe(code);
      await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'Long', code: `${code}X` })
        .expect(400);
    });

    it('concurrent POSTs with the same code: exactly one 201, the rest 409, never 500', async () => {
      const code = uniq();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          server().post(ADMIN).set(auth()).send({ name: 'C', code }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      for (const r of results) {
        if (r.status === 201) track((r.body as AgencyBody).id);
      }
    });

    it('code is immutable through PATCH', async () => {
      const created = await server()
        .post(ADMIN)
        .set(auth())
        .send({ name: 'Imm', code: uniq() })
        .expect(201);
      const { id } = created.body as AgencyBody;
      track(id);
      await server()
        .patch(`${ADMIN}/${id}`)
        .set(auth())
        .send({ code: 'CHANGED' })
        .expect(400);
    });
  });

  describe('DELETE /admin/shipping/agencies/:id', () => {
    const create = async (): Promise<string> => {
      const a = await prisma.shippingAgency.create({
        data: { name: 'Del', code: `D-${randomUUID().slice(0, 10)}` },
      });
      extraAgencyIds.push(a.id);
      return a.id;
    };

    it('401 without token', async () => {
      await server().delete(`${ADMIN}/${randomUUID()}`).expect(401);
    });

    it('204 deletes an unreferenced agency; then 404', async () => {
      const id = await create();
      await server().delete(`${ADMIN}/${id}`).set(auth()).expect(204);
      expect(
        await prisma.shippingAgency.findUnique({ where: { id } }),
      ).toBeNull();
      for (const bad of [id, 'not-a-uuid']) {
        const res = await server()
          .delete(`${ADMIN}/${bad}`)
          .set(auth())
          .expect(404);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'SHIPPING_AGENCY_NOT_FOUND',
        );
      }
    });

    it('409 SHIPPING_AGENCY_IN_USE when an address references it', async () => {
      const id = await create();
      const customer = await prisma.customer.create({
        data: {
          email: `e2e-17-1-${randomUUID()}@212collectorsclub.test`,
          name: 'E2E 17.1 del',
        },
      });
      customerIds.push(customer.id);
      await prisma.customerAddress.create({
        data: {
          customerId: customer.id,
          agencyId: id,
          recipientName: 'T',
          recipientPhone: '04121234567',
          recipientIdDoc: 'V-12345678',
          deliveryMode: 'AGENCY_OFFICE',
          state: 'Miranda',
          municipality: 'Baruta',
        },
      });
      const res = await server()
        .delete(`${ADMIN}/${id}`)
        .set(auth())
        .expect(409);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'SHIPPING_AGENCY_IN_USE',
      );
      expect(
        await prisma.shippingAgency.findUnique({ where: { id } }),
      ).not.toBeNull();
    });

    it('409 SHIPPING_AGENCY_IN_USE when an order references it (history kept)', async () => {
      const id = await create();
      const order = await prisma.order.create({
        data: {
          status: 'PAYMENT_PROCESSING',
          paymentRail: 'PAGO_MOVIL',
          fulfillmentType: 'DELIVERY',
          recipientName: 'T',
          recipientPhone: '04121234567',
          totalUsd: 1,
          accessTokenHash: `e2e171-${randomUUID()}`,
          shippingAgencyId: id,
        },
      });
      try {
        await server().delete(`${ADMIN}/${id}`).set(auth()).expect(409);
        const kept = await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(kept.shippingAgencyId).toBe(id);
      } finally {
        await prisma.order.delete({ where: { id: order.id } });
      }
    });
  });

  describe('schema guarantees', () => {
    it('partial unique index: a second default address for a customer fails with P2002', async () => {
      const customer = await prisma.customer.create({
        data: {
          email: `e2e-17-1-${randomUUID()}@212collectorsclub.test`,
          name: 'E2E 17.1',
        },
      });
      customerIds.push(customer.id);
      const mrw = await seeded('MRW');
      const addr = (isDefault: boolean) => ({
        customerId: customer.id,
        agencyId: mrw.id,
        recipientName: 'Test',
        recipientPhone: '04121234567',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'AGENCY_OFFICE' as const,
        state: 'Miranda',
        municipality: 'Baruta',
        isDefault,
      });
      await prisma.customerAddress.create({ data: addr(true) });
      await prisma.customerAddress.create({ data: addr(false) });
      await prisma.customerAddress.create({ data: addr(false) });
      await expect(
        prisma.customerAddress.create({ data: addr(true) }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('seed createMany(skipDuplicates) is idempotent and keeps admin edits', async () => {
      const mrw = await seeded('MRW');
      await prisma.shippingAgency.update({
        where: { id: mrw.id },
        data: { name: 'Edited by admin' },
      });
      const before = await prisma.shippingAgency.count({
        where: { code: { in: SEEDED_CODES } },
      });
      for (let i = 0; i < 2; i++) {
        const r = await prisma.shippingAgency.createMany({
          data: SEEDED_CODES.map((code, n) => ({
            name: code,
            code,
            sortOrder: n + 1,
          })),
          skipDuplicates: true,
        });
        expect(r.count).toBe(0);
      }
      expect(
        await prisma.shippingAgency.count({
          where: { code: { in: SEEDED_CODES } },
        }),
      ).toBe(before);
      expect((await seeded('MRW')).name).toBe('Edited by admin');
    });
  });
});
