import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { VERIFICATION_PREFIX } from './../src/customer-auth/customer-auth.service.js';

type App = Parameters<typeof request>[0];

const TAG = randomUUID().slice(0, 8);
const ADMIN_USER = `e2e-13-1-${TAG}`;
const ADMIN_PASSWORD = 'e2e-13-1-admin-password';
const emailOf = (k: string) => `e2e-13-1-${TAG}-${k}@212collectorsclub.test`;
const URL = '/api/v1/admin/customers/verify-email';

/** Story 13.1 e2e (FR-53, AD-39): flag-gated manual customer email verification. */
describe('Manual customer email verification (Story 13.1, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: ConfigService;
  let adminId: string;
  let token: string;
  const customerIds: string[] = [];
  const server = () => app.getHttpServer();
  const post = (body: unknown, auth = true) => {
    const r = request(server()).post(URL);
    if (auth) r.set('Authorization', `Bearer ${token}`);
    return r.send(body as object);
  };
  const setFlag = (v: string | undefined) => {
    if (v === undefined) delete process.env.MANUAL_EMAIL_VERIFY_ENABLED;
    else process.env.MANUAL_EMAIL_VERIFY_ENABLED = v;
  };

  async function makeCustomer(key: string, emailVerified = false) {
    const c = await prisma.customer.create({
      data: { email: emailOf(key), name: 'E2E 13.1', emailVerified },
    });
    customerIds.push(c.id);
    return c;
  }
  const pending = (customerId: string) =>
    prisma.customerVerification.count({
      where: {
        value: customerId,
        identifier: { startsWith: VERIFICATION_PREFIX },
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    config = app.get(ConfigService);
    app.use(cookieParser(config.getOrThrow<string>('COOKIE_SECRET')));
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

    const admin = await prisma.adminUser.create({
      data: {
        username: ADMIN_USER,
        email: `${ADMIN_USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    adminId = admin.id;
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    setFlag(undefined);
    await prisma.customerVerification.deleteMany({
      where: { value: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  describe('flag off (AC1)', () => {
    it.each([undefined, 'false', 'TRUE', '1'])(
      'flag %j: 404 standard body with token, bad token and none; hidden in swagger',
      async (v) => {
        setFlag(v);
        for (const r of [
          await post({ email: 'a@b.co' }),
          await request(server())
            .post(URL)
            .set('Authorization', 'Bearer junk')
            .send({}),
          await post({}, false),
        ]) {
          expect(r.status).toBe(404);
          expect(r.body).toEqual({
            message: `Cannot POST ${URL}`,
            error: 'Not Found',
            statusCode: 404,
          });
          expect(r.body).not.toHaveProperty('errorCode');
        }
        const docs = await request(server()).get('/api/docs-json');
        expect(
          Object.keys((docs.body as { paths: object }).paths),
        ).not.toContain('/api/v1/admin/customers/verify-email');
      },
    );
  });

  describe('flag on', () => {
    beforeAll(() => setFlag('true'));
    afterAll(() => setFlag(undefined));

    it('401 INVALID_ADMIN_TOKEN without / with bad token (AC2)', async () => {
      for (const r of [
        await post({ email: 'a@b.co' }, false),
        await request(server())
          .post(URL)
          .set('Authorization', 'Bearer junk')
          .send({ email: 'a@b.co' }),
      ]) {
        expect(r.status).toBe(401);
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'INVALID_ADMIN_TOKEN',
        );
      }
    });

    it('verifies, normalizes email, deletes only own verification rows, is idempotent (AC3/4/5/9)', async () => {
      const c = await makeCustomer('ok');
      const other = await makeCustomer('other');
      const exp = new Date(Date.now() + 3600_000);
      await prisma.customerVerification.createMany({
        data: [
          {
            identifier: VERIFICATION_PREFIX + 'aaa' + TAG,
            value: c.id,
            expiresAt: exp,
          },
          { identifier: 'hashed-reset-' + TAG, value: c.id, expiresAt: exp },
          {
            identifier: VERIFICATION_PREFIX + 'bbb' + TAG,
            value: other.id,
            expiresAt: exp,
          },
        ],
      });
      const res = await post({
        email: `  ${emailOf('ok').toUpperCase().replace('212COLLECTORSCLUB.TEST', '212collectorsclub.test')}  `,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ email: emailOf('ok'), emailVerified: true });
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
          .emailVerified,
      ).toBe(true);
      expect(await pending(c.id)).toBe(0);
      expect(await pending(other.id)).toBe(1);
      expect(
        await prisma.customerVerification.count({
          where: { identifier: 'hashed-reset-' + TAG },
        }),
      ).toBe(1);

      const again = await post({ email: emailOf('ok') });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(res.body);
    });

    it('404 CUSTOMER_NOT_FOUND for unknown email (AC6)', async () => {
      const r = await post({ email: emailOf('ghost') });
      expect(r.status).toBe(404);
      expect((r.body as { errorCode: string }).errorCode).toBe(
        'CUSTOMER_NOT_FOUND',
      );
    });

    it.each([
      ['missing', {}],
      ['empty', { email: '' }],
      ['non-string', { email: 5 }],
      ['malformed', { email: 'nope' }],
      ['unknown field', { email: 'a@b.co', extra: 1 }],
    ])('400 on %s body and nothing modified (AC7)', async (_n, body) => {
      const c = await makeCustomer(`bad-${_n.replace(/\W/g, '')}`);
      const r = await post({ ...body });
      expect(r.status).toBe(400);
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
          .emailVerified,
      ).toBe(false);
    });

    it('concurrent calls: no 500, final state verified (AC10)', async () => {
      const c = await makeCustomer('race');
      await prisma.customerVerification.create({
        data: {
          identifier: VERIFICATION_PREFIX + 'ccc' + TAG,
          value: c.id,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const rs = await Promise.all(
        [1, 2, 3, 4].map(() => post({ email: emailOf('race') })),
      );
      rs.forEach((r) => expect(r.status).toBe(200));
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
          .emailVerified,
      ).toBe(true);
      expect(await pending(c.id)).toBe(0);
    });

    it('route appears in no swagger path even when on (AC1)', async () => {
      const docs = await request(server()).get('/api/docs-json');
      expect(Object.keys((docs.body as { paths: object }).paths)).not.toContain(
        '/api/v1/admin/customers/verify-email',
      );
    });
  });
});
