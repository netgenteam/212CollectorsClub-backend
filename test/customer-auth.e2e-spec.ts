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
type Body = { errorCode?: string; phone?: string | null; name?: string };

const EMAIL = 'e2e-customer-12-3@212collectorsclub.test';
const OTHER_EMAIL = 'e2e-customer-12-3-b@212collectorsclub.test';
const PASSWORD = 'correct-horse-battery-12-3';
const ADMIN_USERNAME = 'e2e-admin-story-12-3';
const ADMIN_EMAIL = 'e2e-admin-story-12-3@212collectorsclub.test';
const ADMIN_PASSWORD = 'admin-password-for-12-3';
const GENERIC_REGISTER_MESSAGE =
  'If this email can be registered, the account has been created. You can now log in.';

/**
 * Story 12.3 e2e (FR-41, FR-42): customer register/login/me/PATCH/logout via
 * the httpOnly `cc_session` cookie, anti-enumeration, per-IP throttling,
 * sliding sessions and strict admin<->customer separation. A fresh app per
 * test gives each test a fresh in-memory throttling budget.
 */
describe('Customer auth (Story 12.3, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;

  const server = () => app.getHttpServer();

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanCustomers();

    const admin = await prisma.adminUser.upsert({
      where: { username: ADMIN_USERNAME },
      create: {
        username: ADMIN_USERNAME,
        email: ADMIN_EMAIL,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
      update: {},
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    await cleanCustomers();
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  async function cleanCustomers() {
    await prisma.customer.deleteMany({
      where: { email: { in: [EMAIL, OTHER_EMAIL] } },
    });
  }

  const register = (body: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/auth/register')
      .send({
        email: EMAIL,
        password: PASSWORD,
        name: 'Ada Collector',
        ...body,
      });

  const login = (body: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD, ...body });

  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  /** `cc_session=<value>` pair ready for a Cookie header. */
  const sessionCookie = (res: request.Response): string => {
    const c = setCookies(res).find((s) => s.startsWith('cc_session='));
    if (!c)
      throw new Error(
        `no cc_session cookie: ${JSON.stringify(setCookies(res))}`,
      );
    return c.split(';')[0];
  };

  async function registerAndLogin(): Promise<string> {
    await register().expect(201);
    const res = await login().expect(200);
    return sessionCookie(res);
  }

  async function adminToken(): Promise<string> {
    const res = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  describe('AC1/AC2: register', () => {
    it('201 generic body, Argon2id hash, no session, no cookie, email normalized', async () => {
      const res = await register({ email: `  ${EMAIL.toUpperCase()} ` }).expect(
        201,
      );
      expect(res.body).toEqual({ message: GENERIC_REGISTER_MESSAGE });
      expect(setCookies(res)).toEqual([]);

      const customer = await prisma.customer.findUnique({
        where: { email: EMAIL },
        include: { customeraccounts: true, customersessions: true },
      });
      expect(customer).toMatchObject({
        email: EMAIL,
        name: 'Ada Collector',
        emailVerified: false,
        phone: null,
      });
      expect(customer?.customersessions).toHaveLength(0);
      expect(customer?.customeraccounts).toHaveLength(1);
      expect(customer?.customeraccounts[0].providerId).toBe('credential');
      expect(customer?.customeraccounts[0].password).toMatch(/^\$argon2id\$/);
    });
  });

  describe('AC3: anti-enumeration', () => {
    it('an already-registered email gets the identical response and no second account', async () => {
      const first = await register().expect(201);
      const second = await register({
        password: 'a-different-password-1',
        name: 'Other',
      }).expect(201);
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(setCookies(second)).toEqual([]);
      expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(1);
      // The original password is untouched.
      await login().expect(200);
    });

    it('concurrent registrations of one email never 500 and create one account', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => register()),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(1);
    });
  });

  describe('AC4: validation', () => {
    it.each([
      ['short password', { password: 'short' }],
      ['invalid email', { email: 'not-an-email' }],
      ['empty name', { name: '   ' }],
      ['unknown field', { role: 'admin' }],
      ['unknown field emailVerified', { emailVerified: true }],
    ])('400 on %s', async (_n, body) => {
      await register(body).expect(400);
      expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(0);
    });
  });

  describe('AC5: login', () => {
    it('200 + profile + cc_session cookie (httpOnly, lax, 7 days), no token in body, unverified allowed', async () => {
      await register().expect(201);
      const res = await login({ email: EMAIL.toUpperCase() }).expect(200);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        email: EMAIL,
        name: 'Ada Collector',
        phone: null,
        emailVerified: false,
      });
      expect(res.headers['authorization']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/token|password|hash/i);
      const raw = setCookies(res).find((s) => s.startsWith('cc_session='));
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).toMatch(/Max-Age=604800/);
      expect(raw).not.toMatch(/Secure/i); // dev/test only
      expect(res.headers['set-auth-token']).toBeUndefined();
      expect(
        await prisma.customerSession.count({
          where: { user: { email: EMAIL } },
        }),
      ).toBe(1);
    });
  });

  describe('AC6: invalid credentials', () => {
    it('wrong password and unknown email: identical 401 INVALID_CUSTOMER_CREDENTIALS', async () => {
      await register().expect(201);
      const wrong = await login({ password: 'wrong-password-1' }).expect(401);
      const unknown = await login({ email: OTHER_EMAIL }).expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body).toMatchObject({
        statusCode: 401,
        errorCode: 'INVALID_CUSTOMER_CREDENTIALS',
      });
      expect(setCookies(wrong)).toEqual([]);
      expect(setCookies(unknown)).toEqual([]);
    });
  });

  describe('AC7: GET /auth/me', () => {
    it('200 with the profile only', async () => {
      const cookie = await registerAndLogin();
      const res = await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        email: EMAIL,
        name: 'Ada Collector',
        phone: null,
        emailVerified: false,
      });
    });

    it.each([
      ['no cookie', undefined],
      ['garbage cookie', 'cc_session=garbage'],
      ['forged unsigned token', 'cc_session=abcdefghijklmnopqrstuvwxyz012345'],
    ])('401 INVALID_CUSTOMER_TOKEN with %s', async (_n, cookie) => {
      const req = request(server()).get('/api/v1/auth/me');
      if (cookie) req.set('Cookie', cookie);
      const res = await req.expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        errorCode: 'INVALID_CUSTOMER_TOKEN',
      });
    });

    it('401 for a tampered signature and for an expired session', async () => {
      const cookie = await registerAndLogin();
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie.slice(0, -4) + 'AAAA')
        .expect(401);

      await prisma.customerSession.updateMany({
        where: { user: { email: EMAIL } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(401);
    });
  });

  describe('AC8: PATCH /auth/me', () => {
    it('changes only name/phone (and can clear phone)', async () => {
      const cookie = await registerAndLogin();
      const res = await request(server())
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send({ name: '  New Name ', phone: '+58 412 555 0100' })
        .expect(200);
      expect(res.body).toMatchObject({
        email: EMAIL,
        name: 'New Name',
        phone: '+58 412 555 0100',
        emailVerified: false,
      });
      const cleared = await request(server())
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send({ phone: null })
        .expect(200);
      expect((cleared.body as Body).phone).toBeNull();
      expect((cleared.body as Body).name).toBe('New Name');
    });

    it.each([
      ['email', { email: OTHER_EMAIL }],
      ['emailVerified', { emailVerified: true }],
      ['role', { role: 'admin' }],
      ['id', { id: '11111111-1111-4111-8111-111111111111' }],
      ['roleTier', { roleTier: 'superadmin' }],
      ['mixed valid + forbidden', { name: 'X', emailVerified: true }],
    ])('400 when sending %s, and nothing changes', async (_n, body) => {
      const cookie = await registerAndLogin();
      await request(server())
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send(body)
        .expect(400);
      const row = await prisma.customer.findUniqueOrThrow({
        where: { email: EMAIL },
      });
      expect(row).toMatchObject({
        email: EMAIL,
        name: 'Ada Collector',
        emailVerified: false,
      });
    });

    it('400 on invalid name/phone and 401 without a session', async () => {
      const cookie = await registerAndLogin();
      await request(server())
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send({ name: '' })
        .expect(400);
      await request(server())
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send({ phone: 'abc' })
        .expect(400);
      await request(server())
        .patch('/api/v1/auth/me')
        .send({ name: 'x' })
        .expect(401);
    });
  });

  describe('AC9: logout', () => {
    it('204, row deleted, cookie cleared, old cookie 401', async () => {
      const cookie = await registerAndLogin();
      const res = await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      const cleared = setCookies(res).find((s) => s.startsWith('cc_session='));
      expect(cleared).toMatch(/^cc_session=;/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(
        await prisma.customerSession.count({
          where: { user: { email: EMAIL } },
        }),
      ).toBe(0);
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(401);
      await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(401);
    });

    it('concurrent logouts never produce 500', async () => {
      const cookie = await registerAndLogin();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(server()).post('/api/v1/auth/logout').set('Cookie', cookie),
        ),
      );
      for (const r of results) expect([204, 401]).toContain(r.status);
      expect(results.some((r) => r.status === 204)).toBe(true);
    });
  });

  describe('AC10: sliding session', () => {
    it('extends a session older than 1 day (and refreshes the cookie); 401 once older than 7 days', async () => {
      const cookie = await registerAndLogin();
      const fiveAndHalfDays = new Date(Date.now() + 5.5 * 24 * 3600 * 1000);
      await prisma.customerSession.updateMany({
        where: { user: { email: EMAIL } },
        data: { expiresAt: fiveAndHalfDays },
      });

      const res = await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200);
      const row = await prisma.customerSession.findFirstOrThrow({
        where: { user: { email: EMAIL } },
      });
      expect(row.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 6.9 * 24 * 3600 * 1000,
      );
      expect(setCookies(res).some((s) => s.startsWith('cc_session='))).toBe(
        true,
      );

      // A fresh session (< 1 day old) is NOT touched.
      const before = row.expiresAt.getTime();
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200);
      const after = await prisma.customerSession.findFirstOrThrow({
        where: { user: { email: EMAIL } },
      });
      expect(after.expiresAt.getTime()).toBe(before);

      await prisma.customerSession.updateMany({
        where: { user: { email: EMAIL } },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(401);
    });
  });

  describe('AC11: rate limit', () => {
    it('login: the 6th attempt from one IP is 429', async () => {
      await register().expect(201);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await login({ password: 'wrong-password-1' })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('register: the 6th attempt from one IP is 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await register()).status);
      }
      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    });

    it('/auth/me and /auth/logout are not throttled', async () => {
      const cookie = await registerAndLogin();
      for (let i = 0; i < 8; i++) {
        await request(server())
          .get('/api/v1/auth/me')
          .set('Cookie', cookie)
          .expect(200);
      }
    });
  });

  describe('AC12: admin <-> customer separation (FR-41)', () => {
    it('customer cookie / forced Bearer never pass AdminAuthGuard', async () => {
      const cookie = await registerAndLogin();
      const value = decodeURIComponent(cookie.split('=')[1]);

      for (const path of [
        '/api/v1/admin/auth/me',
        '/api/v1/admin/categories',
      ]) {
        const viaCookie = await request(server())
          .get(path)
          .set('Cookie', cookie)
          .expect(401);
        expect((viaCookie.body as Body).errorCode).toBe('INVALID_ADMIN_TOKEN');
        for (const bearer of [value, cookie.split('=')[1]]) {
          const viaBearer = await request(server())
            .get(path)
            .set('Authorization', `Bearer ${bearer}`)
            .expect(401);
          expect((viaBearer.body as Body).errorCode).toBe(
            'INVALID_ADMIN_TOKEN',
          );
        }
      }
      await request(server())
        .post('/api/v1/admin/auth/logout')
        .set('Cookie', cookie)
        .expect(401);
    });

    it('an admin Bearer token (or its value as cc_session) never passes /auth/me or the other customer routes', async () => {
      const token = await adminToken();
      await request(server())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      for (const attempt of [
        (r: request.Test) => r.set('Authorization', `Bearer ${token}`),
        (r: request.Test) => r.set('Cookie', `cc_session=${token}`),
        (r: request.Test) =>
          r.set('Cookie', `cc_session=${encodeURIComponent(token)}`),
        (r: request.Test) =>
          r.set('Cookie', `admin.session_token=${encodeURIComponent(token)}`),
      ]) {
        const res = await attempt(
          request(server()).get('/api/v1/auth/me'),
        ).expect(401);
        expect((res.body as Body).errorCode).toBe('INVALID_CUSTOMER_TOKEN');
        await attempt(
          request(server()).patch('/api/v1/auth/me').send({ name: 'x' }),
        ).expect(401);
        await attempt(request(server()).post('/api/v1/auth/logout')).expect(
          401,
        );
      }
      // The admin session survived all of that.
      await request(server())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('a customer session works next to an admin Authorization header without interference, and vice versa', async () => {
      const cookie = await registerAndLogin();
      const token = await adminToken();
      await request(server())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(server())
        .get('/api/v1/admin/auth/me')
        .set('Cookie', cookie)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('logging out the customer does not touch admin sessions; the admin login contract is unchanged', async () => {
      const cookie = await registerAndLogin();
      const token = await adminToken();
      await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      await request(server())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const res = await request(server())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
        .expect(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String) as string,
        tokenType: 'Bearer',
        expiresIn: 28800,
      });
    });

    it('an Authorization: Bearer orderAccessToken-style value never authenticates a customer', async () => {
      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer ' + 'a'.repeat(64))
        .expect(401);
    });
  });
});
