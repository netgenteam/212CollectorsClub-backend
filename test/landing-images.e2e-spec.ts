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
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { LANDING_IMAGES_DIR } from './../src/admin-catalog/product-image-upload-paths.constants.js';
import { pngOf, webpOf } from './fixtures/landing-images.js';
import { validBlock } from './../src/admin-landing/landing-blocks.fixtures.js';

type App = Parameters<typeof request>[0];

const TEST_USERNAME = 'e2e-admin-story-16-2';
const TEST_EMAIL = 'e2e-admin-story-16-2@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-16-2';
const BASE = '/api/v1/admin/landing-content';

interface ErrBody {
  errorCode?: string;
  details?: {
    errors?: { path: string; messages: string[] }[];
    ids?: string[];
  };
}

/**
 * Story 16.2 (FR-72..74; AD-61, AD-63, AD-64). Full-stack e2e: landing image
 * upload, heroScene url/ratio checks, vitrina expansion and GET draft. Like
 * 16.1 it owns the `section='home'` rows (wiped before/after each test) and
 * deletes every file it uploads.
 */
describe('Landing images, vitrina and draft view (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  const uploaded: string[] = [];
  const productIds: string[] = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const wipe = () =>
    prisma.landingConfigEntry.deleteMany({ where: { section: 'home' } });
  const upload = (
    buf: Buffer,
    kind?: string,
    ct = 'image/png',
    name = 'a.png',
  ) =>
    request(app.getHttpServer())
      .post(`${BASE}/images${kind ? `?kind=${kind}` : ''}`)
      .set(auth())
      .attach('file', buf, { filename: name, contentType: ct });
  const track = (url: string) => {
    uploaded.push(url);
    return url;
  };
  const fileOf = (url: string) =>
    join(LANDING_IMAGES_DIR, url.split('/').pop()!);

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
    await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    await wipe();
  });

  afterEach(async () => {
    await wipe();
    for (const url of uploaded.splice(0)) {
      await rm(fileOf(url), { force: true });
    }
    if (productIds.length) {
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      productIds.length = 0;
    }
    await app.close();
  });

  describe('POST images', () => {
    it('401 without token', async () => {
      await request(app.getHttpServer()).post(`${BASE}/images`).expect(401);
      await request(app.getHttpServer()).get(`${BASE}/draft`).expect(401);
    });

    it('stores a valid card (630x880) and reports url/size/bytes', async () => {
      const buf = pngOf(630, 880);
      const res = await upload(buf, 'card').expect(201);
      const body = res.body as {
        url: string;
        width: number;
        height: number;
        bytes: number;
      };
      track(body.url);
      expect(body.url).toMatch(
        /^\/uploads\/public\/landing\/[0-9a-f-]{36}\.png$/,
      );
      expect([body.width, body.height, body.bytes]).toEqual([
        630,
        880,
        buf.length,
      ]);
      await access(fileOf(body.url));
    });

    it('accepts webp as generic, ignoring the declared content type', async () => {
      const res = await upload(
        webpOf(800, 800),
        undefined,
        'text/plain',
        'x.bin',
      ).expect(201);
      const { url } = res.body as { url: string };
      track(url);
      expect(url).toMatch(/\.webp$/);
    });

    it('400 UNSUPPORTED_FILE_TYPE for text bytes named .png or with fake image/png', async () => {
      const res = await upload(
        Buffer.from('definitely not a png'),
        'generic',
      ).expect(400);
      expect((res.body as ErrBody).errorCode).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('400 LANDING_IMAGE_REQUIRED without a file', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/images`)
        .set(auth())
        .field('x', 'y')
        .expect(400);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_IMAGE_REQUIRED');
    });

    it('413 LANDING_IMAGE_TOO_LARGE above the limit', async () => {
      const big = Buffer.concat([
        pngOf(300, 300),
        Buffer.alloc(3 * 1024 * 1024),
      ]);
      const res = await upload(big).expect(413);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_IMAGE_TOO_LARGE');
    });

    it('422 LANDING_IMAGE_DIMENSIONS and BAD_RATIO leave no file behind', async () => {
      const before = await listDir();
      const small = await upload(pngOf(150, 210)).expect(422);
      expect((small.body as ErrBody).errorCode).toBe(
        'LANDING_IMAGE_DIMENSIONS',
      );
      const ratio = await upload(pngOf(800, 800), 'card').expect(422);
      expect(ratio.body).toMatchObject({
        errorCode: 'LANDING_IMAGE_BAD_RATIO',
        details: { width: 800, height: 800, expected: 0.7159, tolerance: 0.03 },
      });
      expect(await listDir()).toEqual(before);
    });

    it('400 for an invalid kind', async () => {
      await upload(pngOf(630, 880), 'banner').expect(400);
    });
  });

  describe('heroScene urls', () => {
    const scene = (cards: string[]) => ({
      packImageUrl: '/img/pack.webp',
      cardImageUrls: cards,
    });
    const put = (b: unknown) =>
      request(app.getHttpServer())
        .put(`${BASE}/blocks/heroScene`)
        .set(auth())
        .send(b as object);

    it('rejects foreign urls with LANDING_URL_NOT_ALLOWED', async () => {
      for (const url of [
        'https://x.com/a.png',
        '/uploads/public/products/a.png',
        '/img/../a.png',
      ]) {
        const res = await put(
          scene([url, '/img/b.webp', '/img/c.webp']),
        ).expect(400);
        expect((res.body as ErrBody).errorCode).toBe('LANDING_URL_NOT_ALLOWED');
      }
    });

    it('LANDING_IMAGE_NOT_FOUND for a missing uploaded card', async () => {
      const res = await put(
        scene([
          `/uploads/public/landing/${randomUUID()}.png`,
          '/img/b.webp',
          '/img/c.webp',
        ]),
      ).expect(400);
      expect((res.body as ErrBody).errorCode).toBe('LANDING_IMAGE_NOT_FOUND');
    });

    it('422 when a stored card has a wrong ratio, 200 with a good one', async () => {
      const wide = track(
        (
          (await upload(pngOf(800, 800), 'generic').expect(201)).body as {
            url: string;
          }
        ).url,
      );
      const good = track(
        (
          (await upload(pngOf(630, 880), 'card').expect(201)).body as {
            url: string;
          }
        ).url,
      );
      const bad = await put(scene([wide, '/img/b.webp', '/img/c.webp'])).expect(
        422,
      );
      expect((bad.body as ErrBody).errorCode).toBe('LANDING_IMAGE_BAD_RATIO');
      await put(scene([good, '/img/b.webp', '/img/c.webp'])).expect(200);
    });
  });

  describe('vitrina expansion and GET draft', () => {
    async function mkProduct(
      name: string,
      o: { isActive?: boolean; stock: number },
    ) {
      const cat =
        (await prisma.category.findFirst()) ??
        (await prisma.category.create({
          data: { name: 'e2e-16-2', slug: 'e2e-16-2' },
        }));
      const p = await prisma.product.create({
        data: {
          name,
          slug: `e2e-16-2-${randomUUID().slice(0, 8)}`,
          description: 'e2e 16.2',
          franchise: 'POKEMON',
          productType: 'BOOSTER_PACK',
          rarity: 'COMMON',
          priceUsd: '9.99',
          stock: o.stock,
          heldQty: 0,
          isActive: o.isActive ?? true,
          categoryId: cat.id,
        },
      });
      productIds.push(p.id);
      return p.id;
    }
    const vit = (ids: string[]) => validBlock('vitrina', ids);
    const putBlock = (block: string, b: unknown) =>
      request(app.getHttpServer())
        .put(`${BASE}/blocks/${block}`)
        .set(auth())
        .send(b as object)
        .expect(200);
    const publish = (block: string) =>
      request(app.getHttpServer())
        .post(`${BASE}/blocks/${block}/publish`)
        .set(auth())
        .expect(200);
    const draftView = async () =>
      (
        await request(app.getHttpServer())
          .get(`${BASE}/draft`)
          .set(auth())
          .expect(200)
      ).body as {
        blocks: Record<string, Record<string, unknown>>;
        draftBlocks: string[];
      };
    const publicVitrina = async () =>
      (
        (
          await request(app.getHttpServer())
            .get('/api/v1/landing-content')
            .expect(200)
        ).body as {
          home?: Record<string, { value: { products?: { id: string }[] } }>;
        }
      ).home?.vitrina?.value;

    it('public vitrina keeps only active in-stock products, in order', async () => {
      const a = await mkProduct('Active 16.2', { stock: 5 });
      const b = await mkProduct('Inactive 16.2', { stock: 5, isActive: false });
      const c = await mkProduct('NoStock 16.2', { stock: 0 });
      await putBlock('vitrina', vit([c, b, a]));
      await publish('vitrina');
      const v = await publicVitrina();
      expect(v?.products?.map((p) => p.id)).toEqual([a]);
    });

    it('products is [] when none is available', async () => {
      const c = await mkProduct('NoStock2 16.2', { stock: 0 });
      await putBlock('vitrina', vit([c]));
      await publish('vitrina');
      expect((await publicVitrina())?.products).toEqual([]);
    });

    it('GET draft returns effective values and never leaks into the public GET', async () => {
      expect(await draftView()).toEqual({ blocks: {}, draftBlocks: [] });

      const a = await mkProduct('Active3 16.2', { stock: 3 });
      await putBlock('ticker', validBlock('ticker'));
      await publish('ticker');
      const newer = { items: [{ text: 'Borrador nuevo' }] };
      await putBlock('ticker', newer);
      await putBlock('vitrina', vit([a]));

      const d = await draftView();
      expect(d.draftBlocks.sort()).toEqual(['ticker', 'vitrina']);
      expect(d.blocks.ticker).toEqual(newer);
      expect(
        (d.blocks.vitrina.products as { id: string }[]).map((p) => p.id),
      ).toEqual([a]);
      expect(Object.keys(d.blocks).sort()).toEqual(['ticker', 'vitrina']);

      // Public: published ticker only, no vitrina (never published).
      const pub = await request(app.getHttpServer())
        .get('/api/v1/landing-content')
        .expect(200);
      const home = (pub.body as { home: Record<string, { value: unknown }> })
        .home;
      expect(home.ticker.value).toEqual(validBlock('ticker'));
      expect(home.vitrina).toBeUndefined();
    });
  });

  async function listDir(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    return (
      await readdir(LANDING_IMAGES_DIR).catch(() => [] as string[])
    ).sort();
  }
});
