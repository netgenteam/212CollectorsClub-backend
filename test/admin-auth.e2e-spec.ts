import { randomUUID } from 'node:crypto';
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
        // Story 7.2: every real token carries a jti from this point on —
        // included here so this test genuinely exercises the "admin not
        // found" 401 path, not the separate "missing jti" 401 path.
        jti: randomUUID(),
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

  /**
   * Story 7.2 (AD-11, FR-21). Builds its own throwaway INestApplication the
   * same way `beforeEach` above does — used only by the "survives an app
   * restart" test below, which needs a SECOND, independently-constructed
   * app instance (never sharing the first instance's in-process state) to
   * prove the revocation denylist is real Postgres state, not an
   * in-memory Set that would trivially "work" within a single process.
   */
  async function buildFreshApp(): Promise<INestApplication<App>> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const freshApp =
      moduleFixture.createNestApplication<INestApplication<App>>();
    const freshConfigService = freshApp.get(ConfigService);
    freshApp.use(
      cookieParser(freshConfigService.getOrThrow<string>('COOKIE_SECRET')),
    );
    freshApp.setGlobalPrefix('api');
    freshApp.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    freshApp.useGlobalPipes(createGlobalValidationPipe());
    await freshApp.init();
    return freshApp;
  }

  describe('POST /api/v1/admin/auth/logout', () => {
    it('no Authorization header at all: 401 INVALID_ADMIN_TOKEN — cannot log out without being logged in', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .expect(401);
      const body = res.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
        throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
      }
    });

    it('a valid token: 204, and that SAME token is rejected on any subsequent request (here, GET /me)', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);
      const { accessToken } = loginRes.body as AdminLoginResponse;

      // Token works before logout.
      await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      // Same token, same still-unexpired JWT — now rejected everywhere.
      const rejectedRes = await request(app.getHttpServer())
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
      const body = rejectedRes.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
        throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
      }

      // Confirm the row really landed in Postgres (not just "the request
      // got rejected for some other reason").
      const decoded = jwtService.decode<{ jti: string }>(accessToken);
      const revokedRow = await prisma.revokedToken.findUnique({
        where: { jti: decoded.jti },
      });
      if (!revokedRow) {
        throw new Error('Expected a RevokedToken row for the logged-out jti');
      }
      await prisma.revokedToken.delete({ where: { jti: decoded.jti } });
    });

    it('double logout of the same token: the second call also gets 401 INVALID_ADMIN_TOKEN (it never reaches the logout handler a second time — same guard, same revocation check as any other route)', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);
      const { accessToken } = loginRes.body as AdminLoginResponse;

      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const secondRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
      const body = secondRes.body as ApiErrorBody;
      if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
        throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
      }

      const decoded = jwtService.decode<{ jti: string }>(accessToken);
      await prisma.revokedToken
        .delete({ where: { jti: decoded.jti } })
        .catch(() => undefined);
    });

    it('TRUE concurrent double logout (Promise.all, NOT sequential awaits) of the SAME freshly-issued token: neither request ever surfaces a raw 500, the jti ends up revoked exactly once in Postgres, and the whole race is repeated with a fresh token many times over to rule out intermittency — regression test for the QA-found bug where `revokedToken.upsert` is NOT atomic against a second truly-concurrent upsert for the same PK under Prisma 7.10.0 + @prisma/adapter-pg (both requests can see "no row yet" and both attempt `create`; the loser used to get an uncaught P2002 that fell through to a raw 500 — AdminAuthService.logout now catches that P2002 and treats it as a successful no-op)', async () => {
      // What counts as "handled cleanly" here (documented since the Dev
      // brief left this to judgement): in a genuine race, BOTH concurrent
      // requests can pass AdminAuthGuard's revocation check (which reads
      // RevokedToken by jti) before EITHER write commits — that shared
      // window is the race itself — so BOTH reach
      // AdminAuthService.logout() and BOTH should resolve 204 (the fix
      // catches the loser's P2002 and swallows it as success). Depending
      // on real scheduling/DB round-trip timing, it is also possible for
      // one request's guard check to land AFTER the other request's row
      // has already committed; that request is correctly rejected at the
      // guard with 401 INVALID_ADMIN_TOKEN, same as any other
      // already-revoked token — a different but equally correct
      // interleaving, not a bug. The only outcome this test forbids is a
      // raw 5xx on either side, and it additionally requires that AT
      // LEAST ONE of the pair actually succeeds with 204 (so the token is
      // guaranteed to end up revoked, never silently dropped by both
      // sides swallowing an error).
      const RACE_ITERATIONS = 15;

      for (let i = 0; i < RACE_ITERATIONS; i++) {
        const loginRes = await request(app.getHttpServer())
          .post('/api/v1/admin/auth/login')
          .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
          .expect(200);
        const { accessToken } = loginRes.body as AdminLoginResponse;

        // Promise.all, not `await` one then the other — both requests are
        // in flight on the wire at the same time, which is what actually
        // exercises the race window (a sequential double-logout, like the
        // existing test above, never does).
        const [resA, resB] = await Promise.all([
          request(app.getHttpServer())
            .post('/api/v1/admin/auth/logout')
            .set('Authorization', `Bearer ${accessToken}`),
          request(app.getHttpServer())
            .post('/api/v1/admin/auth/logout')
            .set('Authorization', `Bearer ${accessToken}`),
        ]);

        for (const res of [resA, resB]) {
          if (res.status >= 500) {
            throw new Error(
              `iteration ${i}: a truly concurrent logout must NEVER surface a 5xx, got ${res.status}: ${JSON.stringify(res.body)}`,
            );
          }
          if (res.status !== 204 && res.status !== 401) {
            throw new Error(
              `iteration ${i}: expected 204 or 401 from a concurrent logout, got ${res.status}: ${JSON.stringify(res.body)}`,
            );
          }
        }
        if (resA.status !== 204 && resB.status !== 204) {
          throw new Error(
            `iteration ${i}: expected at least one of the two concurrent logouts to succeed with 204, got ${resA.status} and ${resB.status}`,
          );
        }

        // Regardless of which concurrent request "won", the token must be
        // unusable afterwards.
        const meRes = await request(app.getHttpServer())
          .get('/api/v1/admin/auth/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(401);
        const meBody = meRes.body as ApiErrorBody;
        if (meBody.errorCode !== 'INVALID_ADMIN_TOKEN') {
          throw new Error(
            `iteration ${i}: expected INVALID_ADMIN_TOKEN after a concurrent logout, got ${JSON.stringify(meBody)}`,
          );
        }

        // Exactly one RevokedToken row for this jti — never duplicated by
        // the race, never missing either, even though two concurrent
        // writes contended for the exact same primary key.
        const decoded = jwtService.decode<{ jti: string }>(accessToken);
        const revokedRows = await prisma.revokedToken.findMany({
          where: { jti: decoded.jti },
        });
        if (revokedRows.length !== 1) {
          throw new Error(
            `iteration ${i}: expected exactly 1 RevokedToken row for jti ${decoded.jti}, found ${revokedRows.length}`,
          );
        }

        await prisma.revokedToken.delete({ where: { jti: decoded.jti } });
      }
    }, 30_000);

    it('a revoked token is STILL rejected against a brand-new app instance (simulates surviving a real process restart — the denylist is Postgres, never in-memory)', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);
      const { accessToken } = loginRes.body as AdminLoginResponse;

      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      // A fresh app instance, from a fresh TestingModule — no state carried
      // over from `app` above except whatever is in the shared Postgres DB.
      const restartedApp = await buildFreshApp();
      try {
        const res = await request(restartedApp.getHttpServer())
          .get('/api/v1/admin/auth/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(401);
        const body = res.body as ApiErrorBody;
        if (body.errorCode !== 'INVALID_ADMIN_TOKEN') {
          throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
        }
      } finally {
        await restartedApp.close();
      }

      const decoded = jwtService.decode<{ jti: string }>(accessToken);
      await prisma.revokedToken
        .delete({ where: { jti: decoded.jti } })
        .catch(() => undefined);
    });
  });
});
