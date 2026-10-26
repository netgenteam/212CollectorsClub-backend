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

const PASSWORD = 'Correct-horse-17-3!';
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
 * Story 17.3 (FR-84/85, AD-72/73): PATCH, set-default, DELETE. Real Postgres.
 * Customers and the extra agency are created here and removed in afterAll.
 */
describe('Customer addresses update/default/delete (e2e, Story 17.3)', () => {
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
    const email = `e2e-addrw-${k}-${tag}@212collectorsclub.test`;
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

  const patch = (s: string, id: string, b: object) =>
    request(server()).patch(`${URL}/${id}`).set('Cookie', s).send(b);
  const setDef = (s: string, id: string) =>
    request(server()).patch(`${URL}/${id}/set-default`).set('Cookie', s);
  const del = (s: string, id: string) =>
    request(server()).delete(`${URL}/${id}`).set('Cookie', s);
  const mk = async (s: string, over: Record<string, unknown> = {}) =>
    (await post(s, body(over)).expect(201)).body as Addr;
  const defaults = (cid: string) =>
    prisma.customerAddress.count({
      where: { customerId: cid, isDefault: true },
    });

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
    const id = randomUUID();
    await request(server())
      .patch(`${URL}/${id}`)
      .send({ state: 'X' })
      .expect(401);
    await request(server()).patch(`${URL}/${id}/set-default`).expect(401);
    await request(server()).delete(`${URL}/${id}`).expect(401);
  });

  it("404 ADDRESS_NOT_FOUND for another customer's, unknown and non-uuid ids (never 403)", async () => {
    const a = await customer('isoa');
    const b = await customer('isob');
    const rb = await mk(b.s);
    for (const id of [rb.id, randomUUID(), 'not-a-uuid']) {
      for (const r of [
        await patch(a.s, id, { state: 'Zulia' }),
        await setDef(a.s, id),
        await del(a.s, id),
      ]) {
        expect(r.status).toBe(404);
        expect((r.body as Err).errorCode).toBe('ADDRESS_NOT_FOUND');
      }
    }
    const lb = (await list(b.s).expect(200)).body as { data: Addr[] };
    expect(lb.data).toHaveLength(1);
    expect(lb.data[0]).toMatchObject({ id: rb.id, state: 'Miranda' });
  });

  it('PATCH partial update, normalization, never touches isDefault', async () => {
    const { s } = await customer('patch');
    const a1 = await mk(s);
    const a2 = await mk(s);
    const r = await patch(s, a2.id, {
      state: 'Zulia',
      recipientIdDoc: 'e 987654321',
      label: ' Oficina ',
    }).expect(200);
    expect(r.body).toMatchObject({
      id: a2.id,
      state: 'Zulia',
      recipientIdDoc: 'E-987654321',
      label: 'Oficina',
      municipality: 'Baruta',
      isDefault: false,
    });
    const r1 = await patch(s, a1.id, {
      referencePoint: 'Frente a la plaza',
    }).expect(200);
    expect((r1.body as Addr).isDefault).toBe(true);
  });

  it('PATCH 400: isDefault, unknown field, empty body, bad types; SHIPPING_INVALID on merged result', async () => {
    const { s } = await customer('patch400');
    const a = await mk(s);
    await patch(s, a.id, { isDefault: true }).expect(400);
    await patch(s, a.id, { foo: 1 }).expect(400);
    await patch(s, a.id, {}).expect(400);
    await patch(s, a.id, { state: 5 }).expect(400);
    const nul = await patch(s, a.id, { agencyId: null }).expect(400);
    expect((nul.body as Err).errorCode).toBe('SHIPPING_INVALID');
    expect((nul.body as Err).details?.errors).toEqual([
      { field: 'agencyId', code: 'REQUIRED' },
    ]);
    await patch(s, a.id, { agencyId: 'nope' }).expect(400);
    const bad = await patch(s, a.id, { recipientIdDoc: 'X-1' }).expect(400);
    expect((bad.body as Err).details?.errors).toEqual([
      { field: 'recipientIdDoc', code: 'INVALID' },
    ]);
    expect(JSON.stringify(bad.body)).not.toContain('X-1');
    // home -> office without a branch name: resulting combination is invalid.
    const mode = await patch(s, a.id, { deliveryMode: 'agency_office' }).expect(
      400,
    );
    expect((mode.body as Err).details?.errors).toEqual([
      { field: 'agencyBranchName', code: 'REQUIRED' },
    ]);
    await patch(s, a.id, {
      deliveryMode: 'agency_office',
      agencyBranchName: 'Chacao',
    }).expect(200);
    // back to home: addressLine1 is still stored, ok; clearing it now fails.
    await patch(s, a.id, {
      deliveryMode: 'home_delivery',
      addressLine1: null,
    }).expect(400);
    const stored = await prisma.customerAddress.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(stored).toMatchObject({
      deliveryMode: 'AGENCY_OFFICE',
      state: 'Miranda',
    });
  });

  it('PATCH 422: unknown agency, disallowed mode; inactive agency allowed only when agencyId is not sent', async () => {
    const { s } = await customer('patch422');
    const a = await mk(s);
    expect(
      (
        (await patch(s, a.id, { agencyId: randomUUID() }).expect(422))
          .body as Err
      ).errorCode,
    ).toBe('SHIPPING_AGENCY_UNAVAILABLE');
    expect(
      ((await patch(s, a.id, { agencyId: domesa.id }).expect(422)).body as Err)
        .errorCode,
    ).toBe('DELIVERY_MODE_NOT_ALLOWED');

    const ag = await prisma.shippingAgency.create({
      data: { name: `E2E ${tag}`, code: `E2W-${tag}`.toUpperCase() },
    });
    agencyIds.push(ag.id);
    const b = await mk(s, { agencyId: ag.id });
    await prisma.shippingAgency.update({
      where: { id: ag.id },
      data: { isActive: false },
    });
    // AC5: still listed (isActive=false), editable without touching agency, deletable.
    const l = (await list(s).expect(200)).body as { data: Addr[] };
    expect(l.data.find((x) => x.id === b.id)?.agency.isActive).toBe(false);
    await patch(s, b.id, { state: 'Lara' }).expect(200);
    // re-selecting the inactive agency is rejected; moving to an active one works.
    await patch(s, b.id, { agencyId: ag.id }).expect(422);
    const moved = await patch(s, b.id, { agencyId: mrw.id }).expect(200);
    expect((moved.body as Addr).agency.code).toBe('MRW');
    await prisma.shippingAgency.update({
      where: { id: ag.id },
      data: { isActive: false },
    });
    await del(s, b.id).expect(204);
  });

  it('set-default moves the flag, is idempotent, and keeps exactly one default', async () => {
    const { id, s } = await customer('setdef');
    const a1 = await mk(s);
    const a2 = await mk(s);
    const r = await setDef(s, a2.id).expect(200);
    expect((r.body as Addr).isDefault).toBe(true);
    const again = await setDef(s, a2.id).expect(200);
    expect((again.body as Addr).isDefault).toBe(true);
    expect(await defaults(id)).toBe(1);
    const l = (await list(s).expect(200)).body as { data: Addr[] };
    expect(l.data.map((x) => x.id)).toEqual([a2.id, a1.id]);
  });

  it('DELETE: 204; deleting the default promotes the most recent; last one leaves none', async () => {
    const { id, s } = await customer('del');
    const a1 = await mk(s);
    const a2 = await mk(s);
    const a3 = await mk(s);
    await del(s, a2.id).expect(204);
    expect(await defaults(id)).toBe(1);
    await del(s, a1.id).expect(204); // was default -> a3 (most recent)
    const l = (await list(s).expect(200)).body as { data: Addr[] };
    expect(l.data).toHaveLength(1);
    expect(l.data[0]).toMatchObject({ id: a3.id, isDefault: true });
    await del(s, a3.id).expect(204);
    expect(
      await prisma.customerAddress.count({ where: { customerId: id } }),
    ).toBe(0);
    await del(s, a3.id).expect(404);
    // next POST becomes default again
    expect((await mk(s)).isDefault).toBe(true);
  });

  it('concurrency: parallel set-default on different addresses -> exactly one default', async () => {
    const { id, s } = await customer('cset');
    const addrs: Addr[] = [];
    for (let i = 0; i < 6; i++) addrs.push(await mk(s));
    const results = await Promise.all(addrs.map((a) => setDef(s, a.id)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(await defaults(id)).toBe(1);
  });

  it('concurrency: DELETE of the default in parallel with set-default and POST keeps invariants', async () => {
    for (let round = 0; round < 3; round++) {
      const { id, s } = await customer(`cdel${round}`);
      const a1 = await mk(s);
      const a2 = await mk(s);
      const a3 = await mk(s);
      const rs = await Promise.all([
        del(s, a1.id),
        setDef(s, a2.id),
        post(s, body()),
        setDef(s, a3.id),
        del(s, a2.id),
      ]);
      for (const r of rs) expect([200, 201, 204, 404]).toContain(r.status);
      const remaining = await prisma.customerAddress.count({
        where: { customerId: id },
      });
      expect(remaining).toBeGreaterThan(0);
      expect(await defaults(id)).toBe(1);
    }
  });
});
