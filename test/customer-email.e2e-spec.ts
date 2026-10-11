import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];
type Body = { errorCode?: string; emailVerified?: boolean; message?: string };
type Mail = { id: string; subject: string; body: string };

const EMAIL = 'e2e-customer-12-4@212collectorsclub.test';
const GHOST = 'e2e-customer-12-4-ghost@212collectorsclub.test';
const PASSWORD = 'correct-horse-battery-12-4';
const NEW_PASSWORD = 'brand-new-password-12-4';
const sha256b64 = (t: string) =>
  createHash('sha256').update(t).digest('base64url');
const MAILHOG = 'http://localhost:8025';

/** Mail bodies are quoted-printable: undo soft breaks and =XX escapes. */
const qpDecode = (s: string) =>
  s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );

async function mailsTo(email: string): Promise<Mail[]> {
  const res = await fetch(
    `${MAILHOG}/api/v2/search?kind=to&query=${encodeURIComponent(email)}&limit=50`,
  );
  const json = (await res.json()) as {
    items: {
      ID: string;
      Content: { Headers: { Subject: string[] }; Body: string };
    }[];
  };
  return json.items.map((i) => ({
    id: i.ID,
    subject: i.Content.Headers.Subject[0],
    body: qpDecode(i.Content.Body),
  }));
}

async function clearMailsTo(email: string) {
  for (const m of await mailsTo(email)) {
    await fetch(`${MAILHOG}/api/v1/messages/${encodeURIComponent(m.id)}`, {
      method: 'DELETE',
    });
  }
}

/** Mails are sent best-effort in the background: poll until they land. */
async function waitForMail(email: string, subject: RegExp): Promise<Mail> {
  for (let i = 0; i < 50; i++) {
    const m = (await mailsTo(email)).find((x) => subject.test(x.subject));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail ${subject} for ${email} in MailHog`);
}

const tokenFrom = (mail: Mail, path: string): string => {
  const m = new RegExp(
    `http://frontend\\.test/${path}\\?token=([A-Za-z0-9_%.-]+)`,
  ).exec(mail.body);
  if (!m) throw new Error(`no ${path} link in: ${mail.body}`);
  return decodeURIComponent(m[1]);
};

/**
 * Story 12.4 e2e (FR-43): email verification, "already registered" email and
 * password reset, reading the emails from MailHog's API. Tokens are never in
 * an HTTP body. A fresh app per test = fresh throttling budget.
 */
describe(
  'Customer email verification and password reset (Story 12.4, e2e)',
  { timeout: 20000 },
  () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    const server = () => app.getHttpServer();

    beforeEach(async () => {
      process.env.FRONTEND_URL = 'http://frontend.test';
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
      await cleanup();
    });

    afterEach(async () => {
      await cleanup();
      await app.close();
    });

    async function cleanup() {
      const existing = await prisma.customer.findUnique({
        where: { email: EMAIL },
      });
      if (existing) {
        await prisma.customerVerification.deleteMany({
          where: { value: existing.id },
        });
      }
      await prisma.customer.deleteMany({ where: { email: { in: [EMAIL] } } });
      await prisma.customerVerification.deleteMany({
        where: { identifier: { startsWith: 'email-verification:' } },
      });
      await clearMailsTo(EMAIL);
      await clearMailsTo(GHOST);
    }

    const register = () =>
      request(server())
        .post('/api/v1/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' });
    const login = (password = PASSWORD) =>
      request(server())
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password });
    const me = (cookie: string) =>
      request(server()).get('/api/v1/auth/me').set('Cookie', cookie);
    const cookieOf = (res: request.Response) =>
      ((res.headers['set-cookie'] as unknown as string[]) ?? [])
        .find((c) => c.startsWith('cc_session='))!
        .split(';')[0];
    const verify = (token: string) =>
      request(server()).post('/api/v1/auth/verify-email').send({ token });
    const forgot = (email = EMAIL) =>
      request(server()).post('/api/v1/auth/forgot-password').send({ email });
    const reset = (token: string, password = NEW_PASSWORD) =>
      request(server())
        .post('/api/v1/auth/reset-password')
        .send({ token, password });

    async function registerAndGetVerifyToken() {
      const res = await register().expect(201);
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
      const mail = await waitForMail(EMAIL, /Verify/);
      return tokenFrom(mail, 'verify-email');
    }

    describe('verification (AC1, AC3, AC9)', () => {
      it('register sends the link; verify flips emailVerified; unverified login works before', async () => {
        const token = await registerAndGetVerifyToken();
        const before = await login().expect(200);
        expect((before.body as Body).emailVerified).toBe(false);
        const cookie = cookieOf(before);

        const res = await verify(token).expect(200);
        expect(JSON.stringify(res.body)).not.toContain(token);
        const after = await me(cookie).expect(200);
        expect((after.body as Body).emailVerified).toBe(true);
      });

      it('reused, tampered, unknown and expired tokens give 400 INVALID_VERIFICATION_TOKEN', async () => {
        const token = await registerAndGetVerifyToken();
        await verify(token).expect(200);
        for (const t of [token, token + 'x', 'nope', 'a'.repeat(40)]) {
          const res = await verify(t).expect(400);
          expect((res.body as Body).errorCode).toBe(
            'INVALID_VERIFICATION_TOKEN',
          );
        }
      });

      it('an expired (real) token is rejected and the customer stays unverified', async () => {
        const token = await registerAndGetVerifyToken();
        await prisma.customerVerification.updateMany({
          where: { identifier: { startsWith: 'email-verification:' } },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        const res = await verify(token).expect(400);
        expect((res.body as Body).errorCode).toBe('INVALID_VERIFICATION_TOKEN');
        const c = await prisma.customer.findUnique({ where: { email: EMAIL } });
        expect(c?.emailVerified).toBe(false);
      });

      it('unknown fields / missing token are 400 validation errors', async () => {
        await request(server())
          .post('/api/v1/auth/verify-email')
          .send({})
          .expect(400);
        await request(server())
          .post('/api/v1/auth/verify-email')
          .send({ token: 'a', extra: 1 })
          .expect(400);
      });
    });

    describe('already registered (AC2)', () => {
      it('same response; the owner gets the "already have an account" email, no verification link', async () => {
        const first = await register().expect(201);
        await waitForMail(EMAIL, /Verify/);
        await clearMailsTo(EMAIL);
        const second = await register().expect(201);
        expect(second.body).toEqual(first.body);
        const mail = await waitForMail(EMAIL, /already have/);
        expect(mail.body).toContain('http://frontend.test/login');
        expect(mail.body).not.toContain('verify-email');
        expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(
          1,
        );
      });
    });

    describe('forgot / reset password (AC4-AC7)', () => {
      it('existing and unknown emails: identical 200 body; only the existing one is mailed', async () => {
        await register().expect(201);
        await clearMailsTo(EMAIL);
        const a = await forgot(EMAIL).expect(200);
        const b = await forgot(GHOST).expect(200);
        expect(b.body).toEqual(a.body);
        const mail = await waitForMail(EMAIL, /Reset/);
        expect(mail.body).toContain(
          'http://frontend.test/reset-password?token=',
        );
        await new Promise((r) => setTimeout(r, 400));
        expect(await mailsTo(GHOST)).toEqual([]);
        expect(JSON.stringify(a.body)).not.toMatch(/[A-Za-z0-9]{32}/);
      });

      it('full flow: reset changes password, old fails, all sessions revoked, token is one-time', async () => {
        await register().expect(201);
        const c1 = cookieOf(await login().expect(200));
        const c2 = cookieOf(await login().expect(200));
        await me(c1).expect(200);

        await forgot().expect(200);
        const token = tokenFrom(
          await waitForMail(EMAIL, /Reset/),
          'reset-password',
        );

        // short password: 400 and the token is NOT consumed
        await reset(token, 'short').expect(400);

        await reset(token).expect(200);
        await me(c1).expect(401);
        await me(c2).expect(401);
        const old = await login(PASSWORD).expect(401);
        expect((old.body as Body).errorCode).toBe(
          'INVALID_CUSTOMER_CREDENTIALS',
        );
        await login(NEW_PASSWORD).expect(200);
        const stored = await prisma.customerAccount.findFirst({
          where: { user: { email: EMAIL } },
        });
        expect(stored?.password).toMatch(/^\$argon2id\$/);

        const again = await reset(token).expect(400);
        expect((again.body as Body).errorCode).toBe('INVALID_RESET_TOKEN');
      });

      it('invalid and expired (>1h) reset tokens give 400 INVALID_RESET_TOKEN', async () => {
        const bad = await reset('garbage').expect(400);
        expect((bad.body as Body).errorCode).toBe('INVALID_RESET_TOKEN');

        await register().expect(201);
        await forgot().expect(200);
        const token = tokenFrom(
          await waitForMail(EMAIL, /Reset/),
          'reset-password',
        );
        const row = await prisma.customerVerification.findFirst({
          where: { identifier: sha256b64(`reset-password:${token}`) },
        });
        expect(row).not.toBeNull();
        const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
        expect(Math.abs(ttl - 3600_000)).toBeLessThan(5000);
        await prisma.customerVerification.update({
          where: { id: row!.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        const res = await reset(token).expect(400);
        expect((res.body as Body).errorCode).toBe('INVALID_RESET_TOKEN');
        await login(PASSWORD).expect(200);
      });

      it('forgot-password shares the login IP rate limit (429 on the 6th)', async () => {
        for (let i = 0; i < 5; i++) await forgot(GHOST).expect(200);
        await forgot(GHOST).expect(429);
      });
    });
  },
);
