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
import { LandingBlocksService } from './../src/admin-landing/landing-blocks.service.js';
import { LANDING_BLOCKS } from './../src/admin-landing/landing-blocks.constants.js';
import { validBlock } from './../src/admin-landing/landing-blocks.fixtures.js';

type App = Parameters<typeof request>[0];

const TEST_USERNAME = 'e2e-admin-story-16-1';
const TEST_EMAIL = 'e2e-admin-story-16-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-16-1';
const BASE = '/api/v1/admin/landing-content';

interface Detail {
  block: string;
  published: unknown;
  draft: unknown;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
}
interface ErrBody {
  errorCode?: string;
  details?: {
    errors?: { path: string; messages: string[] }[];
    ids?: string[];
  };
}
type PublicLanding = Record<string, Record<string, { value: unknown }>>;

/**
 * Story 16.1 (FR-71, FR-74, NFR-16.1; AD-60, AD-61). Full-stack e2e (real
 * guard, real Postgres) of the Home blocks CMS. It owns the whole
 * `section='home'` table: those rows are wiped before and after each test
 * (no real Home content exists before Story 16.6 ships the editors).
 */
describe('Landing blocks draft/publish (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const wipe = () =>
    prisma.landingConfigEntry.deleteMany({ where: { section: 'home' } });
  const put = (block: string, body: unknown) =>
    request(app.getHttpServer())
      .put(`${BASE}/blocks/${block}`)
      .set(auth())
      .send(body as object);
  const publicHome = async () =>
    (
      (
        await request(app.getHttpServer())
          .get('/api/v1/landing-content')
          .expect(200)
      ).body as PublicLanding
    ).home;

  beforeEach(async () => {
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

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    await wipe();
  });

  afterEach(async () => {
    await wipe();
    await app.close();
  });

  it('401 without token, with a garbage token and on every route', async () => {
    const s = request(app.getHttpServer());
    await s.get(`${BASE}/blocks`).expect(401);
    await s
      .get(`${BASE}/blocks/hero`)
      .set('Authorization', 'Bearer nope')
      .expect(401);
    await s.put(`${BASE}/blocks/hero`).send({}).expect(401);
    await s.post(`${BASE}/blocks/hero/publish`).expect(401);
    await s.delete(`${BASE}/blocks/hero/draft`).expect(401);
    await s.post(`${BASE}/publish`).expect(401);
  });

  it('lists the 7 blocks even when none exists, then reflects draft/published', async () => {
    const list = async () =>
      (
        (
          await request(app.getHttpServer())
            .get(`${BASE}/blocks`)
            .set(auth())
            .expect(200)
        ).body as { data: Record<string, unknown>[] }
      ).data;
    let data = await list();
    expect(data.map((d) => d.block)).toEqual([...LANDING_BLOCKS]);
    expect(data.every((d) => !d.hasDraft && !d.hasPublished)).toBe(true);

    await put('ticker', validBlock('ticker')).expect(200);
    data = await list();
    const t = data.find((d) => d.block === 'ticker')!;
    expect(t).toMatchObject({
      hasDraft: true,
      hasPublished: false,
      publishedAt: null,
    });
    expect(t.draftUpdatedAt).toEqual(expect.any(String));
  });

  it('404 LANDING_BLOCK_UNKNOWN on every block route', async () => {
    const s = request(app.getHttpServer());
    for (const res of [
      await s.get(`${BASE}/blocks/nope`).set(auth()),
      await s.put(`${BASE}/blocks/nope`).set(auth()).send({}),
      await s.post(`${BASE}/blocks/nope/publish`).set(auth()),
      await s.delete(`${BASE}/blocks/nope/draft`).set(auth()),
    ]) {
      expect(res.status).toBe(404);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_BLOCK_UNKNOWN');
    }
  });

  it('PUT creates the row with value {} / publishedAt NULL and only stores a draft', async () => {
    const body = validBlock('manifesto');
    const res = await put('manifesto', body).expect(200);
    expect(res.body).toMatchObject({
      block: 'manifesto',
      published: null,
      draft: body,
      publishedAt: null,
    });
    const row = await prisma.landingConfigEntry.findUniqueOrThrow({
      where: { section_key: { section: 'home', key: 'manifesto' } },
    });
    expect(row).toMatchObject({
      valueType: 'json',
      value: {},
      publishedAt: null,
      draftUpdatedById: adminId,
    });
    const get = await request(app.getHttpServer())
      .get(`${BASE}/blocks/manifesto`)
      .set(auth())
      .expect(200);
    expect((get.body as Detail).draft).toEqual(body);
  });

  it('draft -> public invisible -> publish -> public visible -> discard keeps published', async () => {
    const v1 = validBlock('ticker');
    await put('ticker', v1).expect(200);
    expect((await publicHome()) ?? {}).not.toHaveProperty('ticker');

    const pub = await request(app.getHttpServer())
      .post(`${BASE}/blocks/ticker/publish`)
      .set(auth())
      .expect(200);
    expect(pub.body).toMatchObject({ published: v1, draft: null });
    expect((pub.body as Detail).publishedAt).toEqual(expect.any(String));
    const home = await publicHome();
    expect(home.ticker.value).toEqual(v1);
    expect(JSON.stringify(home)).not.toContain('draftValue');

    // New draft: the public keeps v1, never sees the draft.
    const v2 = { items: [{ text: 'otro' }] };
    await put('ticker', v2).expect(200);
    expect((await publicHome()).ticker.value).toEqual(v1);
    const detail = await request(app.getHttpServer())
      .get(`${BASE}/blocks/ticker`)
      .set(auth())
      .expect(200);
    expect(detail.body).toMatchObject({ published: v1, draft: v2 });

    // Discard: still v1, idempotent (second DELETE and block without row).
    await request(app.getHttpServer())
      .delete(`${BASE}/blocks/ticker/draft`)
      .set(auth())
      .expect(204);
    await request(app.getHttpServer())
      .delete(`${BASE}/blocks/ticker/draft`)
      .set(auth())
      .expect(204);
    await request(app.getHttpServer())
      .delete(`${BASE}/blocks/hero/draft`)
      .set(auth())
      .expect(204);
    expect((await publicHome()).ticker.value).toEqual(v1);
    const after = await request(app.getHttpServer())
      .get(`${BASE}/blocks/ticker`)
      .set(auth());
    expect(after.body).toMatchObject({ published: v1, draft: null });
  });

  it('publish without draft -> 409 LANDING_NO_DRAFT', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/blocks/hero/publish`)
        .set(auth())
        .expect(409);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_NO_DRAFT');
    }
    await put('hero', validBlock('hero')).expect(200);
    await request(app.getHttpServer())
      .post(`${BASE}/blocks/hero/publish`)
      .set(auth())
      .expect(200);
    await request(app.getHttpServer())
      .post(`${BASE}/blocks/hero/publish`)
      .set(auth())
      .expect(409);
  });

  it('publish-all promotes every draft; empty -> 200 []', async () => {
    const empty = await request(app.getHttpServer())
      .post(`${BASE}/publish`)
      .set(auth())
      .expect(200);
    expect(empty.body).toEqual({ published: [] });

    await put('simulator', validBlock('simulator')).expect(200);
    await put('ticker', validBlock('ticker')).expect(200);
    const res = await request(app.getHttpServer())
      .post(`${BASE}/publish`)
      .set(auth())
      .expect(200);
    expect(res.body).toEqual({ published: ['ticker', 'simulator'] });
    const home = await publicHome();
    expect(Object.keys(home).sort()).toEqual(['simulator', 'ticker']);
  });

  it('publish-all is atomic: a failure on the 2nd block publishes none', async () => {
    await put('ticker', validBlock('ticker')).expect(200);
    await put('hero', validBlock('hero')).expect(200);
    await put('manifesto', validBlock('manifesto')).expect(200);

    const service = app.get(LandingBlocksService);
    const original = service.publishRow.bind(service);
    let calls = 0;
    const spy = vi.spyOn(service, 'publishRow').mockImplementation((...a) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('boom'));
      return original(...a);
    });
    const res = await request(app.getHttpServer())
      .post(`${BASE}/publish`)
      .set(auth());
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(calls).toBe(2);

    const rows = await prisma.landingConfigEntry.findMany({
      where: { section: 'home' },
    });
    expect(rows).toHaveLength(3);
    expect(
      rows.every((r) => r.publishedAt === null && r.draftValue !== null),
    ).toBe(true);
    expect((await publicHome()) ?? {}).toEqual({});
  });

  describe('validation (one case per block)', () => {
    async function expectInvalid(block: string, body: unknown, path: string) {
      const res = await put(block, body).expect(400);
      const err = res.body as ErrBody;
      expect(err.errorCode).toBe('LANDING_BLOCK_INVALID');
      expect(err.details?.errors?.map((e) => e.path)).toContain(path);
      const rows = await prisma.landingConfigEntry.count({
        where: { section: 'home', key: block },
      });
      expect(rows).toBe(0);
    }

    it.each(LANDING_BLOCKS)('accepts a valid %s', async (block) => {
      let ids: string[] = [];
      if (block === 'vitrina') ids = [(await anyProduct()).id];
      await put(block, validBlock(block, ids)).expect(200);
    });

    it('ticker with 13 items', () =>
      expectInvalid(
        'ticker',
        { items: Array(13).fill({ text: 'x' }) },
        'items',
      ));

    it('hero with 2 panels', () => {
      const hero = validBlock('hero') as { panels: unknown[] };
      return expectInvalid(
        'hero',
        { panels: hero.panels.slice(0, 2) },
        'panels',
      );
    });

    it('hero with javascript: href and nested path', () => {
      const hero = validBlock('hero') as { panels: Record<string, unknown>[] };
      hero.panels[2].ctas = [{ label: 'x', href: 'javascript:alert(1)' }];
      return expectInvalid('hero', hero, 'panels.2.ctas.0.href');
    });

    it('hero with //host href and bad titleLines segment path', async () => {
      const hero = validBlock('hero') as { panels: Record<string, unknown>[] };
      hero.panels[0].ctas = [{ label: 'x', href: '//evil.com' }];
      await put('hero', hero).expect(400);
      const h2 = validBlock('hero') as { panels: Record<string, unknown>[] };
      (h2.panels[0].titleLines as unknown[][])[1] = [
        { text: '', style: 'solid' },
      ];
      await expectInvalid('hero', h2, 'panels.0.titleLines.1.0.text');
    });

    it('heroScene with a disallowed url', () =>
      expectInvalid(
        'heroScene',
        { ...validBlock('heroScene'), packImageUrl: 'https://evil.com/a.png' },
        'packImageUrl',
      ));

    it('manifesto with an unknown field', () =>
      expectInvalid(
        'manifesto',
        { ...validBlock('manifesto'), extra: true },
        'extra',
      ));

    it('vitrina with repeated ids', () => {
      const id = randomUUID();
      return expectInvalid(
        'vitrina',
        validBlock('vitrina', [id, id]),
        'productIds',
      );
    });

    it('vitrina with more than 12 ids', () =>
      expectInvalid(
        'vitrina',
        validBlock(
          'vitrina',
          Array.from({ length: 13 }, () => randomUUID()),
        ),
        'productIds',
      ));

    it('drop212 with an invalid targetDate', () =>
      expectInvalid(
        'drop212',
        { ...validBlock('drop212'), targetDate: 'mañana' },
        'targetDate',
      ));

    it('simulator with a title line of 5 segments', () =>
      expectInvalid(
        'simulator',
        {
          ...validBlock('simulator'),
          titleLines: [Array(5).fill({ text: 'a', style: 'solid' })],
        },
        'titleLines.0',
      ));

    it('payload over 20 KB', async () => {
      const res = await put('ticker', {
        items: [{ text: 'x'.repeat(25_000) }],
      }).expect(400);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_BLOCK_INVALID');
    });

    it('vitrina with unknown product ids -> LANDING_PRODUCT_NOT_FOUND', async () => {
      const real = await anyProduct();
      const ghost = randomUUID();
      const res = await put(
        'vitrina',
        validBlock('vitrina', [real.id, ghost]),
      ).expect(400);
      const err = res.body as ErrBody;
      expect(err.errorCode).toBe('LANDING_PRODUCT_NOT_FOUND');
      expect(err.details?.ids).toEqual([ghost]);
    });

    it('vitrina accepts inactive products at save time', async () => {
      const p = await anyProduct();
      const original = p.isActive;
      await prisma.product.update({
        where: { id: p.id },
        data: { isActive: false },
      });
      try {
        await put('vitrina', validBlock('vitrina', [p.id])).expect(200);
      } finally {
        await prisma.product.update({
          where: { id: p.id },
          data: { isActive: original },
        });
      }
    });
  });

  it('legacy sections stay in the public GET under their own names', async () => {
    const key = `e2e_${randomUUID().slice(0, 8)}`;
    await request(app.getHttpServer())
      .put(`${BASE}/pack_simulator/${key}`)
      .set(auth())
      .send({ value: { a: 1 } })
      .expect(200);
    try {
      const body = (
        await request(app.getHttpServer())
          .get('/api/v1/landing-content')
          .expect(200)
      ).body as PublicLanding;
      expect(body.pack_simulator[key].value).toEqual({ a: 1 });
    } finally {
      await prisma.landingConfigEntry.deleteMany({
        where: { section: 'pack_simulator', key },
      });
    }
  });

  async function anyProduct() {
    const found = await prisma.product.findFirst();
    if (found) return found;
    const cat =
      (await prisma.category.findFirst()) ??
      (await prisma.category.create({
        data: { name: 'e2e-16-1', slug: 'e2e-16-1' },
      }));
    return prisma.product.create({
      data: {
        name: 'e2e 16.1',
        slug: `e2e-16-1-${randomUUID().slice(0, 8)}`,
        description: 'Created by e2e 16.1.',
        franchise: 'POKEMON',
        productType: 'SEALED',
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock: 1,
        categoryId: cat.id,
      },
    });
  }
});
