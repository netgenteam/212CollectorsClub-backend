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

const PASSWORD = 'Correct-horse-17-2!';
const URL = '/api/v1/auth/addresses';

interface Addr {
  id: string;
  isDefault: boolean;
  recipientIdDoc: string;
  recipientPhone: string;
  deliveryMode: string;
  createdAt: string;
  agency: { code: string; isActive: boolean };
}
interface Err {
  errorCode: string;
  details?: { errors?: { field: string; code: string }[] } & Record<
    string,
    unknown
  >;
}

/**
 * Story 17.2 (FR-84/85, AD-71..73). Real Postgres. Customers (unique emails)
 * and the extra agency are created here and removed in afterAll (the FK
 * cascade drops the addresses); the seeded agencies are never modified.
 */
describe('Customer addresses list/create (e2e, Story 17.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const customerIds: string[] = [];
  const agencyIds: string[] = [];
  let mrw: { id: string };
  let domesa: { id: string };
  const server = () => app.getHttpServer();
  const tag = randomUUID().slice(0, 8);

  const cookieOf = (res: request.Response): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith('cc_session='))
      ?.split(';')[0] as string;

  async function customer(k: string): Promise<{ id: string; s: string }> {
    const email = `e2e-addr-${k}-${tag}@212collectorsclub.test`;
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Addr Tester' })
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
    return { id: c.id, s: cookieOf(res) };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    agencyId: mrw.id,
    deliveryMode: 'home_delivery',
    recipientName: 'Maria Perez',
    recipientPhone: '+58 (412) 123-4567',
    recipientIdDoc: 'v12345678',
    state: 'Miranda',
    municipality: 'Baruta',
    addressLine1: 'Calle 1, Casa 2',
    ...over,
  });
  const post = (s: string, b: unknown) =>
    request(server())
      .post(URL)
      .set('Cookie', s)
      .send(b as object);
  const list = (s: string) => request(server()).get(URL).set('Cookie', s);

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
    mrw = await prisma.shippingAgency.findUniqueOrThrow({
      where: { code: 'MRW' },
    });
    domesa = await prisma.shippingAgency.findUniqueOrThrow({
      where: { code: 'DOMESA' },
    });
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.shippingAgency.deleteMany({
      where: { id: { in: agencyIds } },
    });
    await app.close();
  });

  it('401 without a session', async () => {
    await request(server()).get(URL).expect(401);
    await request(server()).post(URL).send(body()).expect(401);
  });

  it('creates normalized, first is default, then list order (default first, newest next)', async () => {
    const { s } = await customer('order');
    expect((await list(s).expect(200)).body).toEqual({ data: [] });

    const r1 = await post(s, body({ label: 'Casa' })).expect(201);
    const a1 = r1.body as Addr;
    expect(a1).toMatchObject({
      isDefault: true,
      recipientIdDoc: 'V-12345678',
      recipientPhone: '+584121234567',
      deliveryMode: 'home_delivery',
    });
    expect(a1.agency.code).toBe('MRW');
    expect(new Date(a1.createdAt).toISOString()).toBe(a1.createdAt);

    const a2 = (
      await post(
        s,
        body({
          deliveryMode: 'agency_office',
          agencyBranchName: 'Oficina Chacao',
          addressLine1: undefined,
        }),
      ).expect(201)
    ).body as Addr;
    expect(a2.isDefault).toBe(false);
    const a3 = (await post(s, body()).expect(201)).body as Addr;
    expect(a3.isDefault).toBe(false);

    const got = (await list(s).expect(200)).body as { data: Addr[] };
    expect(got.data.map((a) => a.id)).toEqual([a1.id, a3.id, a2.id]);
  });

  it('400: unknown field, bad types, bad uuid/mode; SHIPPING_INVALID without values', async () => {
    const { s } = await customer('val');
    await post(s, body({ isDefault: true })).expect(400);
    await post(s, body({ recipientName: 123 })).expect(400);
    await post(s, body({ agencyId: 'nope' })).expect(400);
    await post(s, body({ deliveryMode: 'pickup' })).expect(400);

    const r = await post(
      s,
      body({
        recipientIdDoc: 'X-1',
        addressLine1: undefined,
        state: undefined,
      }),
    ).expect(400);
    const e = r.body as Err;
    expect(e.errorCode).toBe('SHIPPING_INVALID');
    expect(e.details?.errors).toEqual(
      expect.arrayContaining([
        { field: 'state', code: 'REQUIRED' },
        { field: 'recipientIdDoc', code: 'INVALID' },
        { field: 'addressLine1', code: 'REQUIRED' },
      ]),
    );
    expect(JSON.stringify(r.body)).not.toContain('X-1');

    const office = await post(
      s,
      body({ deliveryMode: 'agency_office', addressLine1: undefined }),
    ).expect(400);
    expect((office.body as Err).details?.errors).toEqual([
      { field: 'agencyBranchName', code: 'REQUIRED' },
    ]);
    expect((await list(s).expect(200)).body).toEqual({ data: [] });
  });

  it('422: unknown/inactive agency and disallowed mode', async () => {
    const { s } = await customer('agency');
    const unknown = await post(s, body({ agencyId: randomUUID() })).expect(422);
    expect((unknown.body as Err).errorCode).toBe('SHIPPING_AGENCY_UNAVAILABLE');

    const inactive = await prisma.shippingAgency.create({
      data: {
        name: `E2E ${tag}`,
        code: `E2E-${tag}`.toUpperCase(),
        isActive: false,
      },
    });
    agencyIds.push(inactive.id);
    const r = await post(s, body({ agencyId: inactive.id })).expect(422);
    expect((r.body as Err).errorCode).toBe('SHIPPING_AGENCY_UNAVAILABLE');

    expect(domesa.id).toBeDefined();
    const d = await post(s, body({ agencyId: domesa.id })).expect(422);
    expect(d.body as Err).toMatchObject({
      errorCode: 'DELIVERY_MODE_NOT_ALLOWED',
      details: { agencyCode: 'DOMESA', deliveryMode: 'home_delivery' },
    });
    expect((await list(s).expect(200)).body).toEqual({ data: [] });
  });

  it('11th address -> 422 ADDRESS_LIMIT_REACHED', async () => {
    const { id, s } = await customer('limit');
    await prisma.customerAddress.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        customerId: id,
        agencyId: mrw.id,
        recipientName: 'X',
        recipientPhone: '+584121234567',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'HOME_DELIVERY' as const,
        state: 'S',
        municipality: 'M',
        addressLine1: 'L',
        isDefault: i === 0,
      })),
    });
    const r = await post(s, body()).expect(422);
    expect((r.body as Err).errorCode).toBe('ADDRESS_LIMIT_REACHED');
    expect(
      await prisma.customerAddress.count({ where: { customerId: id } }),
    ).toBe(10);
  });

  it('5 concurrent POSTs of a customer without addresses -> 5 created, exactly 1 default', async () => {
    const { id, s } = await customer('conc');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post(s, body({ label: `c${i}` }))),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const rows = await prisma.customerAddress.findMany({
      where: { customerId: id },
    });
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it("isolation: A's list never contains B's addresses", async () => {
    const a = await customer('isoa');
    const b = await customer('isob');
    const ra = (await post(a.s, body()).expect(201)).body as Addr;
    const rb = (await post(b.s, body()).expect(201)).body as Addr;
    const la = (await list(a.s).expect(200)).body as { data: Addr[] };
    const lb = (await list(b.s).expect(200)).body as { data: Addr[] };
    expect(la.data.map((x) => x.id)).toEqual([ra.id]);
    expect(lb.data.map((x) => x.id)).toEqual([rb.id]);
  });
});
