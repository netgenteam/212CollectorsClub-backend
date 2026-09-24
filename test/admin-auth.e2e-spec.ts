import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface AdminLoginResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

interface AdminUserResponse {
  id: string;
  username: string;
  email: string;
  roleTier: string | null;
  createdAt: string;
  updatedAt: string;
  passwordHash?: string;
}

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
}

const TEST_USERNAME = 'e2e-admin-story-7-1';
const TEST_EMAIL = 'e2e-admin-story-7-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-9f2c';

/**
 * Story 7.1 (AD-11) e2e suite. Creates its own dedicated AdminUser fixture
 * directly via Prisma (Argon2id-hashed with the real `argon2` package,
 * same as `AdminAuthService`/`prisma/seed.ts` do) rather than depending on
 * `ADMIN_SEED_*` env vars being set in this environment — same reasoning
 * `proof-of-payment.e2e-spec.ts` gives for creating its own Order fixture
 * directly instead of driving a real checkout. A full real
 * seed-then-login-then-/me flow is additionally verified once, by hand,
 * via the live `curl` check in the Dev report.
 */
describe('AdminAuthController (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
    prisma = app.get(PrismaService);

    // Same secret the running app itself uses (ADMIN_JWT_SECRET) — lets
    // this suite hand-craft an expired/tampered token that the app's own
    // AdminJwtStrategy will genuinely reject, and decode a real login
    // response's token without re-verifying it.
    jwtService = new JwtService({
      secret: configService.getOrThrow<string>('ADMIN_JWT_SECRET'),
    });

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: {
        username: TEST_USERNAME,
        email: TEST_EMAIL,
        passwordHash,
      },
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

  describe('POST /api/v1/admin/auth/login', () => {
    it('correct username + correct password: 200 with a valid, never-passwordHash-leaking JWT', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);

      const body = res.body as AdminLoginResponse;
      if (
        typeof body.accessToken !== 'string' ||
        body.accessToken.split('.').length !== 3
      ) {
        throw new Error(
          `Expected a JWT-shaped accessToken, got: ${JSON.stringify(body)}`,
        );
      }
      if (body.tokenType !== 'Bearer' || body.expiresIn !== 28800) {
        throw new Error(`Unexpected token metadata: ${JSON.stringify(body)}`);
      }
      if ('passwordHash' in body) {
        throw new Error('Login response must never include passwordHash');
      }

      const decoded = jwtService.decode<{
        sub: string;
        iat: number;
        exp: number;
      }>(body.accessToken);
      if (decoded.sub !== adminId) {
        throw new Error(
          `JWT sub does not match the AdminUser id: ${JSON.stringify(decoded)}`,
        );
      }
      if (decoded.exp - decoded.iat !== 28800) {
        throw new Error(
          `Expected an 8h (28800s) JWT max-age, got ${decoded.exp - decoded.iat}s`,
        );
      }
    });

    it('correct EMAIL (instead of username) + correct password also succeeds', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD })
        .expect(200);
    });

    it('a username that matches NO AdminUser: 401 INVALID_ADMIN_CREDENTIALS, no token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({
          usernameOrEmail: 'this-username-does-not-exist-at-all',
          password: 'whatever-password',
        })
        .expect(401);

      const body = res.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_CREDENTIALS') {
        throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
      }
    });

    it('a real username with the WRONG password produces the EXACT SAME response as a nonexistent username', async () => {
      const nonexistentRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({
          usernameOrEmail: 'this-username-does-not-exist-at-all',
          password: 'whatever-password',
        })
        .expect(401);

      const wrongPasswordRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({
          usernameOrEmail: TEST_USERNAME,
          password: 'the-wrong-password',
        })
        .expect(401);

      if (
        JSON.stringify(nonexistentRes.body) !==
        JSON.stringify(wrongPasswordRes.body)
      ) {
        throw new Error(
          `Bodies must be identical (no user-enumeration): ${JSON.stringify(
            nonexistentRes.body,
          )} vs ${JSON.stringify(wrongPasswordRes.body)}`,
        );
      }
      const body = wrongPasswordRes.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_CREDENTIALS') {
        throw new Error(`Unexpected errorCode: ${JSON.stringify(body)}`);
      }
    });
  });

  describe('GET /api/v1/admin/auth/me (AdminAuthGuard end-to-end)', () => {
    it('no Authorization header at all: 401 INVALID_ADMIN_TOKEN, never partial data', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .expect(401);
      const body = res.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
        throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
      }
    });

    it('a malformed/garbage token: 401 INVALID_ADMIN_TOKEN', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt-at-all')
        .expect(401)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
            throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
          }
        });
    });

    it('an EXPIRED token (well-signed, but past its exp): 401 INVALID_ADMIN_TOKEN', async () => {
      const expiredToken = jwtService.sign(
        { sub: adminId },
        { expiresIn: '-1s' },
      );
      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
            throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
          }
        });
    });

    it('a TAMPERED token (valid shape, corrupted signature): 401 INVALID_ADMIN_TOKEN', async () => {
      const validToken = jwtService.sign({ sub: adminId });
      const parts = validToken.split('.');
      const tamperedSignature =
        parts[2].slice(0, -4) +
        (parts[2].slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
            throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
          }
        });
    });

    it('a token for an AdminUser id that no longer exists: 401 INVALID_ADMIN_TOKEN', async () => {
      const orphanToken = jwtService.sign({
        sub: '99999999-9999-4999-8999-999999999999',
      });
      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${orphanToken}`)
        .expect(401)
        .expect((res) => {
          const body = res.body as ApiErrorBody;
          if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
            throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
          }
        });
    });

    it('a genuinely valid token (from a real login): 200 with the AdminUser, NEVER passwordHash', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);
      const { accessToken } = loginRes.body as AdminLoginResponse;

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = res.body as AdminUserResponse;
      if (
        body.id !== adminId ||
        body.username !== TEST_USERNAME ||
        body.email !== TEST_EMAIL
      ) {
        throw new Error(`Unexpected AdminUser body: ${JSON.stringify(body)}`);
      }
      if (
        'passwordHash' in body ||
        Object.keys(body).includes('passwordHash')
      ) {
        throw new Error(
          `GET /admin/auth/me must NEVER include passwordHash: ${JSON.stringify(body)}`,
        );
      }
    });
  });
});
