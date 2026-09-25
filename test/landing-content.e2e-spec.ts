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

interface EntryResponse {
  section: string;
  key: string;
  valueType: string;
  value: unknown;
  updatedAt: string;
  updatedById: string | null;
}

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
}

type PublicLandingContent = Record<
  string,
  Record<string, { valueType: string; value: unknown; updatedAt: string }>
>;

const TEST_USERNAME = 'e2e-admin-story-10-1';
const TEST_EMAIL = 'e2e-admin-story-10-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-10-1';

/**
 * Story 10.1 (FR-29, NFR-2, NFR-4; AD-9, AD-10). Full-stack e2e coverage
 * (real AdminAuthGuard, real Postgres) of:
 *  - the two guarded admin PUTs (texts/banners), including the fixed-key
 *    rejection (never creates an arbitrary row) and immediate visibility on
 *    the public GET (no caching layer, AD-10);
 *  - the public GET itself: always 200, grouped by section, no token ever
 *    required;
 *  - AdminAuthGuard gating (no token -> 401) on both PUTs.
 *
 * Prisma-error-translation-free branch coverage (fixed-key rejection,
 * grouping shape) lives in `landing-content.service.spec.ts` against a
 * mocked PrismaService — this suite is about the real end-to-end wiring.
 */
describe('LandingContent (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

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

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    accessToken = (loginRes.body as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    // Story 10.3: unlike texts/banners/drop212 (a fixed, small set of
    // pre-seeded keys these tests overwrite in place — nothing new ever
    // accumulates), pack_simulator has no fixed key set, so these tests use
    // fresh randomUUID()-derived keys (all prefixed "e2e_") to avoid
    // colliding with each other/real data. Clean those rows up here so
    // repeated local runs don't pile up garbage in the shared dev DB —
    // every such key in this file is prefixed "e2e_" by convention.
    await prisma.landingConfigEntry
      .deleteMany({
        where: { section: 'pack_simulator', key: { startsWith: 'e2e_' } },
      })
      .catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  function authed(method: 'put', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  describe('AdminAuthGuard gating — no token on either PUT', () => {
    it('PUT /api/v1/admin/landing-content/texts/heroTitle: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/landing-content/texts/heroTitle')
        .send({ value: 'Should not apply' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('PUT /api/v1/admin/landing-content/banners/banner1: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/landing-content/banners/banner1')
        .send({ imageUrl: 'x', title: 'x', linkUrl: 'x' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('PUT /api/v1/admin/landing-content/drop212/targetDate: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/landing-content/drop212/targetDate')
        .send({ value: '2026-12-25T00:00:00.000Z' })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });

    it('PUT /api/v1/admin/landing-content/pack_simulator/rarityOdds: 401 INVALID_ADMIN_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/landing-content/pack_simulator/rarityOdds')
        .send({ value: { COMMON: 0.6, RARE: 0.4 } })
        .expect(401);
      expect((res.body as ApiErrorBody).errorCode).toBe('INVALID_ADMIN_TOKEN');
    });
  });

  describe('GET /api/v1/landing-content — public, never requires a token', () => {
    it('returns 200 with a valid grouped structure, no Authorization header sent', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = res.body as PublicLandingContent;
      expect(typeof body).toBe('object');
      // Seeded from day one (prisma/seed.ts) — always present in this dev DB.
      expect(body.texts).toBeDefined();
      expect(body.banners).toBeDefined();
    });
  });

  describe('PUT .../texts/{key} -> immediately visible on the public GET', () => {
    it('a valid fixed key: 200, updatedBy = the authenticated admin, and the public GET reflects it on the very next call', async () => {
      const uniqueValue = `E2E hero title ${randomUUID()}`;

      const putRes = await authed(
        'put',
        '/api/v1/admin/landing-content/texts/heroTitle',
      )
        .send({ value: uniqueValue })
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.section).toBe('texts');
      expect(updated.key).toBe('heroTitle');
      expect(updated.valueType).toBe('text');
      expect(updated.value).toBe(uniqueValue);
      expect(updated.updatedById).toBe(adminId);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.texts.heroTitle.value).toBe(uniqueValue);
      expect(body.texts.heroTitle.valueType).toBe('text');
    });

    it('a key outside the fixed set: rejected, and no row is ever created for it (verified directly against Postgres)', async () => {
      const bogusKey = `notARealField_${randomUUID()}`;

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/texts/${bogusKey}`,
      )
        .send({ value: 'should never be persisted' })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_KEY_NOT_EDITABLE',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'texts', key: bogusKey } },
      });
      expect(row).toBeNull();

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.texts[bogusKey]).toBeUndefined();
    });
  });

  describe('PUT .../banners/{key} -> immediately visible on the public GET', () => {
    it('a valid fixed key: 200, and the public GET reflects the full { imageUrl, title, linkUrl } object', async () => {
      const dto = {
        imageUrl: `/uploads/public/landing/e2e-${randomUUID()}.jpg`,
        title: `E2E banner title ${randomUUID()}`,
        linkUrl: '/productos?tag=e2e',
      };

      const putRes = await authed(
        'put',
        '/api/v1/admin/landing-content/banners/banner2',
      )
        .send(dto)
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.section).toBe('banners');
      expect(updated.key).toBe('banner2');
      expect(updated.valueType).toBe('json');
      expect(updated.value).toEqual(dto);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.banners.banner2.value).toEqual(dto);
    });

    it('a key outside the fixed banner set: rejected, and no row is ever created for it', async () => {
      const bogusKey = `banner_bogus_${randomUUID()}`;

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/banners/${bogusKey}`,
      )
        .send({ imageUrl: 'x', title: 'x', linkUrl: 'x' })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_KEY_NOT_EDITABLE',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'banners', key: bogusKey } },
      });
      expect(row).toBeNull();
    });

    it('an incomplete body (missing required field): 400, never persisted', async () => {
      await authed('put', '/api/v1/admin/landing-content/banners/banner3')
        .send({ imageUrl: 'x', title: 'x' })
        .expect(400);
    });
  });

  describe('PUT .../drop212/{key} -> immediately visible on the public GET (Story 10.2)', () => {
    it('targetDate with a real, valid ISO-8601 date/time: 200, valueType "date", reflected immediately on the public GET', async () => {
      const isoValue = '2026-12-25T18:30:00.000Z';

      const putRes = await authed(
        'put',
        '/api/v1/admin/landing-content/drop212/targetDate',
      )
        .send({ value: isoValue })
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.section).toBe('drop212');
      expect(updated.key).toBe('targetDate');
      expect(updated.valueType).toBe('date');
      expect(updated.value).toBe(isoValue);
      expect(updated.updatedById).toBe(adminId);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.drop212.targetDate.value).toBe(isoValue);
      expect(body.drop212.targetDate.valueType).toBe('date');
    });

    it('displayText with free text (including an empty string): 200, valueType "text", reflected immediately on the public GET', async () => {
      const uniqueValue = `E2E countdown caption ${randomUUID()}`;

      const putRes = await authed(
        'put',
        '/api/v1/admin/landing-content/drop212/displayText',
      )
        .send({ value: uniqueValue })
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.section).toBe('drop212');
      expect(updated.key).toBe('displayText');
      expect(updated.valueType).toBe('text');
      expect(updated.value).toBe(uniqueValue);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.drop212.displayText.value).toBe(uniqueValue);
    });

    it.each([
      ['a non-date word', 'mañana'],
      ['an impossible calendar date', '2026-02-30T00:00:00.000Z'],
      ['a malformed month', '2026-13-01T00:00:00.000Z'],
      ['a plain non-ISO string', 'next tuesday at noon'],
    ])(
      'targetDate rejects %s (%j) with 400 LANDING_INVALID_ISO8601_DATE, and it is never persisted (verified directly against Postgres)',
      async (_label, badValue) => {
        const res = await authed(
          'put',
          '/api/v1/admin/landing-content/drop212/targetDate',
        )
          .send({ value: badValue })
          .expect(400);
        expect((res.body as ApiErrorBody).errorCode).toBe(
          'LANDING_INVALID_ISO8601_DATE',
        );

        const row = await prisma.landingConfigEntry.findUnique({
          where: { section_key: { section: 'drop212', key: 'targetDate' } },
        });
        // Never equal to the rejected value — either no row exists yet, or
        // (once another test/seed has set a real value) it still holds
        // that unrelated, previously-valid value, never the bad one.
        expect(row?.value).not.toBe(badValue);
      },
    );

    it('a key outside the fixed drop212 set: rejected with 400 LANDING_KEY_NOT_EDITABLE, and no row is ever created for it', async () => {
      const bogusKey = `drop212_bogus_${randomUUID()}`;

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/drop212/${bogusKey}`,
      )
        .send({ value: 'should never be persisted' })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_KEY_NOT_EDITABLE',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'drop212', key: bogusKey } },
      });
      expect(row).toBeNull();

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.drop212?.[bogusKey]).toBeUndefined();
    });
  });

  describe('PUT .../pack_simulator/{key} -> immediately visible on the public GET (Story 10.3)', () => {
    it('a flat JSON object (simple per-rarity odds table): 200, reflected immediately, exact shape preserved on the public GET', async () => {
      const key = `e2e_flat_${randomUUID().replace(/-/g, '')}`;
      const value = { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 };

      const putRes = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value })
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.section).toBe('pack_simulator');
      expect(updated.key).toBe(key);
      expect(updated.valueType).toBe('json');
      expect(updated.value).toEqual(value);
      expect(updated.updatedById).toBe(adminId);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.pack_simulator[key].value).toEqual(value);
      expect(body.pack_simulator[key].valueType).toBe('json');
    });

    it('a genuinely nested JSON object (per-set, per-rarity odds table): 200, exact nesting/types preserved on the public GET', async () => {
      const key = `e2e_nested_${randomUUID().replace(/-/g, '')}`;
      const value = {
        'base-set': { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 },
        'promo-set': { COMMON: 0.5, RARE: 0.35, ULTRA_RARE: 0.15 },
        featuredSetId: 'base-set',
        pityTimerEnabled: true,
      };

      const putRes = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value })
        .expect(200);
      const updated = putRes.body as EntryResponse;
      expect(updated.value).toEqual(value);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      // Deep-equal against the exact original object — same keys, same
      // nesting depth, same value types (numbers stay numbers, the boolean
      // stays a boolean, not stringified) — the backend never reshapes it.
      expect(body.pack_simulator[key].value).toEqual(value);
    });

    it('a key nobody pre-defined anywhere in the backend is accepted (the open-key-set design decision)', async () => {
      const key = `e2e_totally_novel_variable_${randomUUID().replace(/-/g, '')}`;

      const putRes = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value: { anything: 'goes' } })
        .expect(200);
      expect((putRes.body as EntryResponse).key).toBe(key);
    });

    it('an absent/malformed "value" (missing from the body): rejected with 400, never persisted', async () => {
      const key = `e2e_missing_value_${randomUUID().replace(/-/g, '')}`;

      await authed('put', `/api/v1/admin/landing-content/pack_simulator/${key}`)
        .send({})
        .expect(400);

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'pack_simulator', key } },
      });
      expect(row).toBeNull();
    });

    it('a "value" that is explicitly null: rejected with 400, never persisted', async () => {
      const key = `e2e_null_value_${randomUUID().replace(/-/g, '')}`;

      await authed('put', `/api/v1/admin/landing-content/pack_simulator/${key}`)
        .send({ value: null })
        .expect(400);

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'pack_simulator', key } },
      });
      expect(row).toBeNull();
    });

    it('a malformed key (invalid characters): rejected with 400 LANDING_KEY_INVALID_FORMAT, never persisted', async () => {
      const bogusKey = 'not a valid key!';

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${encodeURIComponent(bogusKey)}`,
      )
        .send({ value: { x: 1 } })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_KEY_INVALID_FORMAT',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'pack_simulator', key: bogusKey } },
      });
      expect(row).toBeNull();
    });

    it('a value nested past the max depth: rejected with 400 LANDING_VALUE_TOO_DEEP, never persisted', async () => {
      const key = `e2e_too_deep_${randomUUID().replace(/-/g, '')}`;
      let deep: unknown = 1;
      for (let i = 0; i < 10; i++) {
        deep = { nested: deep };
      }

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value: deep })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_VALUE_TOO_DEEP',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'pack_simulator', key } },
      });
      expect(row).toBeNull();
    });

    it('a value whose serialized size exceeds the max: rejected with 400 LANDING_VALUE_TOO_LARGE, never persisted', async () => {
      const key = `e2e_too_large_${randomUUID().replace(/-/g, '')}`;
      const huge = { blob: 'x'.repeat(20_000) };

      const res = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value: huge })
        .expect(400);
      expect((res.body as ApiErrorBody).errorCode).toBe(
        'LANDING_VALUE_TOO_LARGE',
      );

      const row = await prisma.landingConfigEntry.findUnique({
        where: { section_key: { section: 'pack_simulator', key } },
      });
      expect(row).toBeNull();
    });

    it('never applies simulator business logic: odds that do not sum to 100% are accepted, not rejected', async () => {
      const key = `e2e_no_business_logic_${randomUUID().replace(/-/g, '')}`;
      // Deliberately "invalid" odds (sums to 150%, not 100%) — if the
      // backend ever grows an odds-sum-to-100% check, this test starts
      // failing, which is the point: FR-31's Technical Note requires the
      // backend to stay pure store-and-serve, no simulator math/validation.
      const notNormalizedOdds = { COMMON: 1.0, RARE: 0.5 };

      const putRes = await authed(
        'put',
        `/api/v1/admin/landing-content/pack_simulator/${key}`,
      )
        .send({ value: notNormalizedOdds })
        .expect(200);
      expect((putRes.body as EntryResponse).value).toEqual(notNormalizedOdds);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.pack_simulator[key].value).toEqual(notNormalizedOdds);
    });

    it('updating the same key twice overwrites (upsert), and the public GET always reflects the latest write', async () => {
      const key = `e2e_overwrite_${randomUUID().replace(/-/g, '')}`;

      await authed('put', `/api/v1/admin/landing-content/pack_simulator/${key}`)
        .send({ value: { COMMON: 0.9, RARE: 0.1 } })
        .expect(200);

      const secondValue = { COMMON: 0.4, RARE: 0.4, ULTRA_RARE: 0.2 };
      await authed('put', `/api/v1/admin/landing-content/pack_simulator/${key}`)
        .send({ value: secondValue })
        .expect(200);

      const publicRes = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const body = publicRes.body as PublicLandingContent;
      expect(body.pack_simulator[key].value).toEqual(secondValue);
    });
  });
});
