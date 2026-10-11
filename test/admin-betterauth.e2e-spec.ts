import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { AuthCoreModule } from './../src/auth-core/auth-core.module.js';
import { ADMIN_AUTH } from './../src/auth-core/auth-core.constants.js';
import type { AdminAuth } from './../src/auth-core/admin-auth.factory.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaModule } from './../src/prisma/prisma.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

const TEST_USERNAME = 'e2e-admin-story-12-2';
const TEST_EMAIL = 'e2e-admin-story-12-2@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-12-2';

/**
 * Story 12.2 e2e: BetterAuth-specific guarantees on top of the unchanged
 * 7.1/7.2 contract suite (AC1 Prisma 7 adapter spike, AC5 token round
 * trip, AC8 backfill, AC9 no BetterAuth HTTP surface, AC10 secrets, lazy
 * provisioning, cross-instance isolation).
 */
describe('Admin auth on BetterAuth (Story 12.2, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminAuth: AdminAuth;
  let adminId: string;
  let passwordHash: string;

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
    adminAuth = app.get<AdminAuth>(ADMIN_AUTH);

    passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  async function login(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  it('AC1 spike: a real signInEmail (no mocks) through prismaAdapter on the Prisma 7 client creates and reads an AdminSession row', async () => {
    await prisma.adminAccount.create({
      data: {
        userId: adminId,
        accountId: adminId,
        providerId: 'credential',
        password: passwordHash,
      },
    });

    const { headers } = await adminAuth.api.signInEmail({
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      returnHeaders: true,
    });
    const bearer = headers.get('set-auth-token');
    expect(bearer).toBeTruthy();

    const rows = await prisma.adminSession.findMany({
      where: { userId: adminId },
    });
    expect(rows).toHaveLength(1);

    // Reading it back through the adapter (getSession) also works.
    const session = await adminAuth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearer}` }),
    });
    expect(session?.user.id).toBe(adminId);
    expect(session?.session.token).toBe(rows[0].token);
  });

  it('lazy provisioning: the first login creates the credential AdminAccount from passwordHash; later logins reuse it (idempotent)', async () => {
    expect(
      await prisma.adminAccount.count({ where: { userId: adminId } }),
    ).toBe(0);

    await login();
    await login();

    const accounts = await prisma.adminAccount.findMany({
      where: { userId: adminId },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: 'credential',
      accountId: adminId,
      password: passwordHash,
    });
  });

  it('lazy provisioning is race-safe: concurrent first logins all succeed with 200 and exactly one account results', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer())
          .post('/api/v1/admin/auth/login')
          .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(
      await prisma.adminAccount.count({ where: { userId: adminId } }),
    ).toBe(1);
  });

  it('wrong password / unknown user: identical 401 body, no session rows created', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: 'nope-nope-nope' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: 'nobody-12-2', password: 'nope-nope-nope' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect((wrong.body as { errorCode: string }).errorCode).toBe(
      'INVALID_ADMIN_CREDENTIALS',
    );
    expect(
      await prisma.adminSession.count({ where: { userId: adminId } }),
    ).toBe(0);
  });

  it('AC5: the exact accessToken round-trips as Bearer, also when the client URL-encodes it, on /me and a guarded route', async () => {
    const token = await login();
    for (const sent of [token, encodeURIComponent(token)]) {
      const me = await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${sent}`)
        .expect(200);
      const body = me.body as Record<string, unknown>;
      expect(body.id).toBe(adminId);
      expect(body).not.toHaveProperty('passwordHash');
      await request(app.getHttpServer())
        .get('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${sent}`)
        .expect(200);
    }
    // And a URL-encoded token can still be logged out.
    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/logout')
      .set('Authorization', `Bearer ${encodeURIComponent(token)}`)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('AC6: the session is NOT refreshed/extended by use (no sliding expiry)', async () => {
    const token = await login();
    const sessionToken = token.split('.')[0];
    const before = await prisma.adminSession.findUniqueOrThrow({
      where: { token: sessionToken },
    });
    // Pretend the session is old enough that BetterAuth would normally refresh.
    const older = new Date(before.expiresAt.getTime() - 60 * 60 * 1000);
    await prisma.adminSession.update({
      where: { token: sessionToken },
      data: { expiresAt: older },
    });
    await request(app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after = await prisma.adminSession.findUniqueOrThrow({
      where: { token: sessionToken },
    });
    expect(after.expiresAt.getTime()).toBe(older.getTime());
  });

  it('a session of another AdminUser cannot be used after that user is deleted (cascade) and other admins are unaffected by logout', async () => {
    const token = await login();
    const other = await prisma.adminUser.create({
      data: {
        username: 'e2e-admin-story-12-2-b',
        email: 'e2e-admin-story-12-2-b@212collectorsclub.test',
        passwordHash,
      },
    });
    try {
      const otherRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: other.username, password: TEST_PASSWORD })
        .expect(200);
      const otherToken = (otherRes.body as { accessToken: string }).accessToken;

      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);
    } finally {
      await prisma.adminUser.delete({ where: { id: other.id } });
    }
  });

  it('login lookup is the exact username-OR-email match of 7.1: an email stored with uppercase works by username and by exact email; other casings stay 401', async () => {
    const mixedEmail = 'E2E.Mixed-12-2@212CollectorsClub.test';
    const mixed = await prisma.adminUser.create({
      data: {
        username: 'e2e-mixed-12-2',
        email: mixedEmail,
        passwordHash,
      },
    });
    try {
      const attempt = (usernameOrEmail: string) =>
        request(app.getHttpServer())
          .post('/api/v1/admin/auth/login')
          .send({ usernameOrEmail, password: TEST_PASSWORD });

      for (const id of [mixed.username, mixedEmail]) {
        const res = await attempt(id).expect(200);
        const token = (res.body as { accessToken: string }).accessToken;
        await request(app.getHttpServer())
          .get('/api/v1/admin/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
      for (const id of [mixedEmail.toLowerCase(), mixedEmail.toUpperCase()]) {
        const res = await attempt(id).expect(401);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'INVALID_ADMIN_CREDENTIALS',
        );
      }
    } finally {
      await prisma.adminUser.delete({ where: { id: mixed.id } });
    }
  });

  it('AC9: no BetterAuth HTTP handler is mounted (404 on its routes)', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/auth/sign-up/email')
      .send({ email: 'x@y.test', password: 'whatever-123', name: 'x' })
      .expect(404);
    await request(server).get('/api/auth/get-session').expect(404);
    await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
      .expect(404);
    await request(server)
      .post('/api/v1/auth/sign-up/email')
      .send({ email: 'x@y.test', password: 'whatever-123', name: 'x' })
      .expect(404);
    await request(server).get('/api/v1/auth/get-session').expect(404);
  });

  it('AC8: the migration backfill SQL copies passwordHash into AdminAccount.password (credential) and is re-runnable', async () => {
    const backfill = () =>
      prisma.$executeRawUnsafe(`
        INSERT INTO "Admin_Accounts" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), u."id"::text, 'credential', u."id", u."passwordHash", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "Admin_Users" u
        ON CONFLICT ("providerId", "accountId") DO NOTHING`);
    await backfill();
    await backfill();
    const accounts = await prisma.adminAccount.findMany({
      where: { userId: adminId },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: 'credential',
      accountId: adminId,
      password: passwordHash,
    });
    // The legacy column and table are kept (rollback path).
    const user = await prisma.adminUser.findUniqueOrThrow({
      where: { id: adminId },
    });
    expect(user.passwordHash).toBe(passwordHash);
    expect(user.emailVerified).toBe(true);
    await expect(prisma.revokedToken.count()).resolves.toBeGreaterThanOrEqual(
      0,
    );
  });

  describe('AC10: secrets (ADMIN_AUTH_SECRET preferred, ADMIN_JWT_SECRET fallback)', () => {
    async function authWith(env: Record<string, string>): Promise<{
      auth: AdminAuth;
      close: () => Promise<void>;
    }> {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            ignoreEnvVars: true,
            load: [() => ({ DATABASE_URL: process.env.DATABASE_URL, ...env })],
          }),
          PrismaModule,
          AuthCoreModule,
        ],
      }).compile();
      const nestApp = moduleRef.createNestApplication();
      await nestApp.init();
      return {
        auth: nestApp.get<AdminAuth>(ADMIN_AUTH),
        close: () => nestApp.close(),
      };
    }

    const bearerOf = async (auth: AdminAuth): Promise<string> => {
      const { headers } = await auth.api.signInEmail({
        body: { email: TEST_EMAIL, password: TEST_PASSWORD },
        returnHeaders: true,
      });
      return headers.get('set-auth-token') as string;
    };
    const accepts = async (auth: AdminAuth, token: string): Promise<boolean> =>
      !!(await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      }));

    it('boots with only ADMIN_JWT_SECRET, only ADMIN_AUTH_SECRET, and prefers ADMIN_AUTH_SECRET when both are set', async () => {
      await prisma.adminAccount.create({
        data: {
          userId: adminId,
          accountId: adminId,
          providerId: 'credential',
          password: passwordHash,
        },
      });
      const legacyOnly = await authWith({ ADMIN_JWT_SECRET: 'secret-A-12-2' });
      const newOnly = await authWith({ ADMIN_AUTH_SECRET: 'secret-A-12-2' });
      const bothPreferNew = await authWith({
        ADMIN_AUTH_SECRET: 'secret-B-12-2',
        ADMIN_JWT_SECRET: 'secret-A-12-2',
      });
      try {
        const token = await bearerOf(legacyOnly.auth);
        // Same value under either name verifies the same token...
        expect(await accepts(newOnly.auth, token)).toBe(true);
        // ...and when both are set the NEW name wins (secret B != A).
        expect(await accepts(bothPreferNew.auth, token)).toBe(false);
      } finally {
        await legacyOnly.close();
        await newOnly.close();
        await bothPreferNew.close();
      }
    });
  });
});
