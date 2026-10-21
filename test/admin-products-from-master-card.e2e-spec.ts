import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  HttpMasterCardImageDownloader,
  MASTER_CARD_IMAGE_DOWNLOADER,
} from './../src/admin-catalog/master-card-image-downloader.js';
import type {
  DownloadedImage,
  MasterCardImageDownloader,
} from './../src/admin-catalog/master-card-image-downloader.js';
import {
  PRODUCT_IMAGES_DIR,
  UPLOADS_PUBLIC_ROOT,
} from './../src/admin-catalog/product-image-upload-paths.constants.js';

const PREFIX = 'e2e156-';
const ADMIN_USER = 'e2e156-admin';
const ADMIN_PASSWORD = 'E2e156-Pass-123!';
const PRODUCTS = '/api/v1/admin/products';
const SEARCH = '/api/v1/admin/tcg-master-cards/search';
const IMAGE_FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  franchise: string;
  productType: string;
  rarity: string;
  editionLanguage: string;
  priceUsd: number;
  stock: number;
  isActive: boolean;
  gradingCompany: string | null;
  masterCardId: string | null;
  isManual: boolean;
  autoSyncPrice: boolean;
  lastMarketSyncAt: string | null;
  category: { slug: string };
  categories: Array<{ id: string; slug: string }>;
  images: Array<{ url: string }>;
  marketReferences: Array<{ provider: string; url: string }>;
}

/**
 * Story 15.6 (FR-69, AD-57): product creation from a master card. The image
 * downloader is replaced by a local fake (or by the real one over a mocked
 * fetch); no external network and no tcgapi call is ever made.
 */
describe('Create product from master card (e2e, Story 15.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let downloader: MasterCardImageDownloader;
  const written = new Set<string>();

  /** Local fake: copies the fixture png into the real images dir. */
  const localDownloader = (): MasterCardImageDownloader => ({
    download: async (): Promise<DownloadedImage> => {
      await mkdir(PRODUCT_IMAGES_DIR, { recursive: true });
      const filename = `${randomUUID()}.png`;
      const path = join(PRODUCT_IMAGES_DIR, filename);
      await copyFile(IMAGE_FIXTURE, path);
      written.add(path);
      return { filename, path };
    },
  });

  const post = () =>
    request(app.getHttpServer())
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`);
  const authed = (m: 'get' | 'patch', path: string) =>
    request(app.getHttpServer())
      [m](path)
      .set('Authorization', `Bearer ${token}`);
  const imageFiles = async () => new Set(await readdir(PRODUCT_IMAGES_DIR));

  async function mkCard(
    n: string,
    over: { price?: string | null; tcgplayerId?: number | null } = {},
  ) {
    return prisma.masterCard.create({
      data: {
        externalProvider: 'FAKE',
        externalId: `${PREFIX}${n}`,
        name: `E2E156 Zardox ${n}`,
        cleanName: `e2e156 zardox ${n}`,
        searchText: `e2e156 zardox ${n} e2e set 1`,
        franchise: 'POKEMON',
        gameSlug: 'pokemon',
        setId: `${PREFIX}set`,
        setName: 'E2E Set',
        cardNumber: '1/10',
        rarity: 'Ultra Rare',
        printing: 'Normal',
        tcgplayerId: over.tcgplayerId === undefined ? 4242 : over.tcgplayerId,
        imageLarge: 'https://product-images.tcgplayer.com/e2e156-large.jpg',
        imageSmall: 'https://product-images.tcgplayer.com/e2e156-small.jpg',
        marketPriceUsd: over.price === undefined ? '12.34' : over.price,
        rawApiData: { id: n },
      },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MASTER_CARD_IMAGE_DOWNLOADER)
      .useValue({ download: (urls: string[]) => downloader.download(urls) })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const config = app.get(ConfigService);
    app.use(cookieParser(config.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.adminUser.create({
      data: {
        username: ADMIN_USER,
        email: `${ADMIN_USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  beforeEach(() => {
    downloader = localDownloader();
  });

  afterEach(async () => {
    const products = await prisma.product.findMany({
      where: { masterCard: { externalId: { startsWith: PREFIX } } },
      select: { id: true, images: { select: { url: true } } },
    });
    for (const p of products) {
      for (const i of p.images) {
        await unlink(
          join(UPLOADS_PUBLIC_ROOT, i.url.replace(/^\/uploads\/public\//, '')),
        ).catch(() => undefined);
      }
    }
    await prisma.product.deleteMany({
      where: { masterCard: { externalId: { startsWith: PREFIX } } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: PREFIX } },
    });
    for (const f of written) await unlink(f).catch(() => undefined);
    written.clear();
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: ADMIN_USER } });
    await app.close();
  });

  it('AC1/2/3/8: builds the product from the card, ignores name/price/images and stores one local image', async () => {
    const card = await mkCard('a');
    const before = await imageFiles();
    const res = await post()
      .field('masterCardId', card.id)
      .field('stock', '5')
      .field('name', 'IGNORED NAME')
      .field('priceUsd', '999')
      .field('slug', 'ignored-slug')
      .attach('images', IMAGE_FIXTURE)
      .expect(201);
    const p = res.body as AdminProduct;
    expect(p).toMatchObject({
      name: card.name,
      slug: `e2e156-zardox-a-e2e-set-1-10-tcg-${PREFIX}a`,
      franchise: 'POKEMON',
      productType: 'SINGLE_CARD',
      rarity: 'ULTRA_RARE',
      editionLanguage: 'EN',
      priceUsd: 12.34,
      stock: 5,
      isActive: true,
      masterCardId: card.id,
      isManual: false,
      autoSyncPrice: true,
    });
    expect(p.category.slug).toBe('cartas-sueltas');
    expect(p.description).toContain('E2E Set');
    expect(Date.now() - Date.parse(p.lastMarketSyncAt!)).toBeLessThan(60_000);
    expect(p.marketReferences).toEqual([
      expect.objectContaining({
        provider: 'TCGPLAYER',
        url: 'https://www.tcgplayer.com/product/4242',
      }),
    ]);
    expect(p.categories.map((c) => c.slug)).toContain('franchise-pokemon');
    expect(p.categories.some((c) => c.slug.startsWith('format-'))).toBe(false);

    // AC2/AC3: exactly one image, local, file exists; the uploaded file is gone.
    expect(p.images).toHaveLength(1);
    expect(p.images[0].url).toMatch(/^\/uploads\/public\/products\/.+\.png$/);
    expect(
      existsSync(
        join(
          UPLOADS_PUBLIC_ROOT,
          p.images[0].url.slice('/uploads/public/'.length),
        ),
      ),
    ).toBe(true);
    const after = await imageFiles();
    expect([...after].filter((f) => !before.has(f))).toHaveLength(1);

    const got = await authed('get', `${PRODUCTS}/${p.id}`).expect(200);
    expect(got.body).toMatchObject({
      masterCardId: card.id,
      isManual: false,
      autoSyncPrice: true,
    });

    // AC8: immediately visible with the franchise tag.
    const tagId = p.categories.find((c) => c.slug === 'franchise-pokemon')!.id;
    const pub = await request(app.getHttpServer())
      .get('/api/v1/products')
      .query({ search: card.name, categoryId: tagId })
      .expect(200);
    expect(
      (pub.body as { data: Array<{ id: string }> }).data.map((d) => d.id),
    ).toContain(p.id);
  });

  it('AC8: isActive=false hides it from the public catalog', async () => {
    const card = await mkCard('b');
    const res = await post()
      .field('masterCardId', card.id)
      .field('stock', '5')
      .field('isActive', 'false')
      .expect(201);
    const p = res.body as AdminProduct;
    expect(p.isActive).toBe(false);
    const pub = await request(app.getHttpServer())
      .get('/api/v1/products')
      .query({ search: card.name })
      .expect(200);
    expect(
      (pub.body as { data: Array<{ id: string }> }).data.map((d) => d.id),
    ).not.toContain(p.id);
  });

  it('AC5: 404 for unknown card, 422 without price, 400 for missing/negative stock', async () => {
    await post()
      .field('masterCardId', randomUUID())
      .field('stock', '1')
      .expect(404)
      .expect((r) =>
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'MASTER_CARD_NOT_FOUND',
        ),
      );
    const noPrice = await mkCard('c', { price: null });
    await post()
      .field('masterCardId', noPrice.id)
      .field('stock', '1')
      .expect(422)
      .expect((r) =>
        expect((r.body as { errorCode: string }).errorCode).toBe(
          'MASTER_CARD_NO_PRICE',
        ),
      );
    const card = await mkCard('d');
    await post().field('masterCardId', card.id).expect(400);
    await post()
      .field('masterCardId', card.id)
      .field('stock', '-1')
      .expect(400);
    await post().field('masterCardId', 'nope').field('stock', '1').expect(400);
    expect(
      await prisma.product.count({ where: { masterCardId: card.id } }),
    ).toBe(0);
  });

  it('AC4: unsafe/failed downloads give 502, no product and no orphan file', async () => {
    const card = await mkCard('e');
    const before = await imageFiles();
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      [
        'bad content-type',
        () =>
          new Response('x', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ],
      [
        'not an image',
        () =>
          new Response('<html>', {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      ],
      [
        'redirect off the allowlist',
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example.com/a.png' },
          }),
      ],
      [
        'http redirect',
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://product-images.tcgplayer.com/a.png' },
          }),
      ],
      ['404', () => new Response('no', { status: 404 })],
    ];
    for (const [, respond] of cases) {
      const fetchMock = vi.fn(() => Promise.resolve(respond()));
      downloader = new HttpMasterCardImageDownloader(
        app.get(ConfigService),
        fetchMock,
      );
      const res = await post()
        .field('masterCardId', card.id)
        .field('stock', '1')
        .expect(502);
      expect((res.body as { errorCode: string }).errorCode).toBe(
        'MASTER_CARD_IMAGE_UNAVAILABLE',
      );
    }
    // Host outside the allowlist: never fetched.
    await prisma.masterCard.update({
      where: { id: card.id },
      data: { imageLarge: 'https://evil.example.com/a.png', imageSmall: null },
    });
    const fetchMock = vi.fn();
    downloader = new HttpMasterCardImageDownloader(
      app.get(ConfigService),
      fetchMock as never,
    );
    await post().field('masterCardId', card.id).field('stock', '1').expect(502);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(
      await prisma.product.count({ where: { masterCardId: card.id } }),
    ).toBe(0);
    expect(await imageFiles()).toEqual(before);
  });

  it('AC4: a valid image over a mocked fetch is stored through the real downloader', async () => {
    const card = await mkCard('f');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(IMAGE_FIXTURE);
    downloader = new HttpMasterCardImageDownloader(app.get(ConfigService), () =>
      Promise.resolve(
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    const res = await post()
      .field('masterCardId', card.id)
      .field('stock', '1')
      .expect(201);
    const p = res.body as AdminProduct;
    expect(
      existsSync(
        join(
          UPLOADS_PUBLIC_ROOT,
          p.images[0].url.slice('/uploads/public/'.length),
        ),
      ),
    ).toBe(true);
  });

  it('AC6: a failure after the image was written removes the file and persists nothing', async () => {
    const card = await mkCard('g');
    const before = await imageFiles();
    // Unknown tag id => replaceTags throws inside the transaction.
    const res = await post()
      .field('masterCardId', card.id)
      .field('stock', '1')
      .field('categoryIds', JSON.stringify([randomUUID()]))
      .expect(400);
    expect((res.body as { errorCode: string }).errorCode).toBe(
      'CATEGORY_NOT_FOUND',
    );
    expect(
      await prisma.product.count({ where: { masterCardId: card.id } }),
    ).toBe(0);
    expect(await imageFiles()).toEqual(before);
  });

  it('AC7: a second product of the same card succeeds (slug suffix) and search sums the stock', async () => {
    const card = await mkCard('h');
    const a = (
      await post()
        .field('masterCardId', card.id)
        .field('stock', '2')
        .expect(201)
    ).body as AdminProduct;
    const b = (
      await post()
        .field('masterCardId', card.id)
        .field('stock', '3')
        .field('gradingCompany', 'PSA')
        .field('gradeValue', '9')
        .field('certNumber', '12345678')
        .expect(201)
    ).body as AdminProduct;
    expect(b.slug).toBe(`${a.slug}-2`);
    expect(b.gradingCompany).toBe('PSA');
    const search = await authed('get', SEARCH)
      .query({ q: 'zardox h' })
      .expect(200);
    const item = (
      search.body as {
        data: Array<{
          id: string;
          printing: string | null;
          alreadyInInventory: boolean;
          currentInventoryStock: number;
        }>;
      }
    ).data.find((d) => d.id === card.id)!;
    expect(item).toMatchObject({
      alreadyInInventory: true,
      currentInventoryStock: 5,
      printing: 'Normal',
    });
  });

  it('AC9: PATCH autoSyncPrice works on linked products, 409 on manual, 400 on non-boolean', async () => {
    const card = await mkCard('i');
    const p = (
      await post()
        .field('masterCardId', card.id)
        .field('stock', '1')
        .expect(201)
    ).body as AdminProduct;
    const patched = await authed('patch', `${PRODUCTS}/${p.id}`)
      .send({ autoSyncPrice: false })
      .expect(200);
    expect((patched.body as AdminProduct).autoSyncPrice).toBe(false);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: p.id } }))
        .autoSyncPrice,
    ).toBe(false);
    await authed('patch', `${PRODUCTS}/${p.id}`)
      .send({ autoSyncPrice: 'maybe' })
      .expect(400);

    const category = await prisma.category.findFirstOrThrow();
    const manual = await prisma.product.create({
      data: {
        name: 'E2E156 manual',
        slug: `${PREFIX}manual`,
        description: 'm',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        priceUsd: '1.00',
        stock: 1,
        categoryId: category.id,
      },
    });
    const conflict = await authed('patch', `${PRODUCTS}/${manual.id}`)
      .send({ autoSyncPrice: true })
      .expect(409);
    expect((conflict.body as { errorCode: string }).errorCode).toBe(
      'NOT_A_LINKED_PRODUCT',
    );
  });

  it('AC10: manual creation is unchanged (image + price required, isManual=true, autoSyncPrice=false)', async () => {
    const category = await prisma.category.findFirstOrThrow();
    const base = () =>
      post()
        .field('name', 'E2E156 Manual')
        .field('slug', `${PREFIX}manual-${randomUUID()}`)
        .field('description', 'd')
        .field('franchise', 'POKEMON')
        .field('productType', 'SINGLE_CARD')
        .field('rarity', 'COMMON')
        .field('stock', '1')
        .field('categoryId', category.id);
    await base().attach('images', IMAGE_FIXTURE).expect(400); // priceUsd required
    await base().field('priceUsd', '5').expect(400); // image required
    const ok = await base()
      .field('priceUsd', '5')
      .attach('images', IMAGE_FIXTURE)
      .expect(201);
    const p = ok.body as AdminProduct;
    expect(p).toMatchObject({
      isManual: true,
      autoSyncPrice: false,
      masterCardId: null,
      lastMarketSyncAt: null,
      priceUsd: 5,
    });
    await unlink(
      join(
        UPLOADS_PUBLIC_ROOT,
        p.images[0].url.slice('/uploads/public/'.length),
      ),
    ).catch(() => undefined);
  });

  it('AC11: Epic 11 grading validation still applies and singleCondition is not accepted', async () => {
    const card = await mkCard('j');
    await post()
      .field('masterCardId', card.id)
      .field('stock', '1')
      .field('gradeValue', '9.5')
      .expect(400);
    await post()
      .field('masterCardId', card.id)
      .field('stock', '1')
      .field('gradingCompany', 'PSA')
      .field('certNumber', 'bad cert!')
      .expect(400);
    const ok = await post()
      .field('masterCardId', card.id)
      .field('stock', '1')
      .field('singleCondition', 'NM')
      .expect(201);
    expect(ok.body).not.toHaveProperty('singleCondition');
  });
});
