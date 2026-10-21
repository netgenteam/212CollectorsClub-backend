import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
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
import { TCG_API_CLIENT } from './../src/tcg/tcg-api-client.interface.js';
import { FakeTcgApiClient } from './../src/tcg/fake-tcg-api-client.js';
import { TcgIngestService } from './../src/tcg/tcg-ingest.service.js';
import { TcgNightlySyncService } from './../src/tcg/tcg-nightly-sync.service.js';
import { MASTER_CARD_IMAGE_DOWNLOADER } from './../src/admin-catalog/master-card-image-downloader.js';
import type { DownloadedImage } from './../src/admin-catalog/master-card-image-downloader.js';
import {
  PRODUCT_IMAGES_DIR,
  UPLOADS_PUBLIC_ROOT,
} from './../src/admin-catalog/product-image-upload-paths.constants.js';

const GAME = 'e2e158';
const PREFIX = 'e2e158-';
const ADMIN_USER = 'e2e158-admin';
const ADMIN_PASSWORD = 'E2e158-Pass-123!';
const SET = (n: number) => FakeTcgApiClient.setIdFor(GAME, n);
const CARD = (setN: number, n: number) => String(Number(SET(setN)) * 100 + n);
const IMAGE_FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

interface Admin {
  id: string;
  priceUsd: number;
  isManual: boolean;
  autoSyncPrice: boolean;
  masterCardId: string | null;
  images: { url: string }[];
}

/**
 * Story 15.8 (FR-60..70, NFR-2): one scenario through the whole Epic 15
 * pipeline with the fake client (no network, no tcgapi call) and a local
 * image downloader. Data is scoped by game slug `e2e158` / slug prefix.
 */
describe('Epic 15 regression (e2e, Story 15.8)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fake: FakeTcgApiClient;
  let token: string;
  const files = new Set<string>();
  const server = () => app.getHttpServer();
  const authed = (m: 'get' | 'post' | 'patch', path: string) =>
    request(server())[m](path).set('Authorization', `Bearer ${token}`);

  const clean = async () => {
    await prisma.product.deleteMany({
      where: {
        OR: [
          { slug: { startsWith: PREFIX } },
          { masterCard: { gameSlug: GAME } },
        ],
      },
    });
    await prisma.masterCard.deleteMany({ where: { gameSlug: GAME } });
    await prisma.tcgIngestCursor.deleteMany({ where: { gameSlug: GAME } });
    await prisma.tcgSyncRun.deleteMany();
  };

  beforeAll(async () => {
    fake = new FakeTcgApiClient();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TCG_API_CLIENT)
      .useValue(fake)
      .overrideProvider(MASTER_CARD_IMAGE_DOWNLOADER)
      .useValue({
        download: async (): Promise<DownloadedImage> => {
          await mkdir(PRODUCT_IMAGES_DIR, { recursive: true });
          const filename = `${randomUUID()}.png`;
          const path = join(PRODUCT_IMAGES_DIR, filename);
          await copyFile(IMAGE_FIXTURE, path);
          files.add(path);
          return { filename, path };
        },
      })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const config = app.get(ConfigService);
    app.use(cookieParser(config.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await clean();
    await prisma.adminUser.create({
      data: {
        username: ADMIN_USER,
        email: `${ADMIN_USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    const imgs = await prisma.productImage.findMany({
      where: { product: { slug: { startsWith: PREFIX } } },
      select: { url: true },
    });
    const linked = await prisma.productImage.findMany({
      where: { product: { masterCard: { gameSlug: GAME } } },
      select: { url: true },
    });
    for (const i of [...imgs, ...linked]) {
      files.add(
        join(UPLOADS_PUBLIC_ROOT, i.url.replace(/^\/uploads\/public\//, '')),
      );
    }
    await clean();
    for (const f of files) await unlink(f).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { username: ADMIN_USER } });
    await app.close();
  });

  it('runs the full Epic 15 flow', async () => {
    // 1. Taxonomy (migrated roots, children, facets).
    const roots = (await request(server())
      .get('/api/v1/categories?type=ROOT')
      .expect(200)) as { body: unknown };
    const rootList = (
      Array.isArray(roots.body)
        ? roots.body
        : (roots.body as { data: unknown }).data
    ) as { slug: string }[];
    for (const slug of [
      'franquicia-tcg',
      'formato-sellado',
      'cartas-sueltas',
    ]) {
      expect(rootList.map((c) => c.slug)).toContain(slug);
    }
    const facets = await request(server())
      .get('/api/v1/catalog/facets')
      .expect(200);
    const fb = facets.body as {
      categoryGroups: { slug: string; children: { slug: string }[] }[];
    };
    expect(
      fb.categoryGroups
        .find((g) => g.slug === 'franquicia-tcg')
        ?.children.map((c) => c.slug),
    ).toContain('franchise-pokemon');
    expect(facets.body).toHaveProperty('totals');

    // 2. Pagination meta and categoryId[] alias (Epic 11 shape + additive).
    const list = await request(server())
      .get('/api/v1/products?limit=2&page=1')
      .expect(200);
    const meta = (list.body as { meta: Record<string, unknown> }).meta;
    expect(meta).toEqual(
      expect.objectContaining({
        page: 1,
        limit: 2,
        hasPreviousPage: false,
        hasNextPage: expect.any(Boolean) as boolean,
      }),
    );
    expect(meta).toHaveProperty('total');
    const cat = rootList.length
      ? await prisma.category.findFirstOrThrow()
      : null;
    await request(server())
      .get(`/api/v1/products?categoryId[]=${cat!.id}&limit=1`)
      .expect(200);
    await request(server()).get('/api/v1/products?categoryId[]=').expect(400);

    // 3. Ingest: idempotent and resumable.
    const ingest = app.get(TcgIngestService);
    await ingest.run({ games: [GAME] });
    const count = () => prisma.masterCard.count({ where: { gameSlug: GAME } });
    const first = await count();
    expect(first).toBeGreaterThan(0);
    await ingest.run({ games: [GAME] });
    expect(await count()).toBe(first);
    expect(
      await prisma.tcgIngestCursor.count({
        where: { gameSlug: GAME, status: 'DONE' },
      }),
    ).toBe(3);
    expect(
      await prisma.product.count({ where: { masterCard: { gameSlug: GAME } } }),
    ).toBe(0);

    // 4. Admin search with printing and alreadyInInventory.
    const search = await authed(
      'get',
      `/api/v1/admin/tcg-master-cards/search?q=${encodeURIComponent(`fake card ${SET(1)}`)}&limit=50`,
    ).expect(200);
    const sb = search.body as {
      data: {
        id: string;
        externalId: string;
        printing: string | null;
        apiPriceUsd: number | null;
        alreadyInInventory: boolean;
      }[];
      meta: Record<string, unknown>;
    };
    expect(sb.meta).toHaveProperty('total');
    const hit = sb.data.find((d) => d.externalId === CARD(1, 1))!;
    expect(hit).toBeDefined();
    expect(hit.printing).toBeDefined();
    expect(hit.alreadyInInventory).toBe(false);

    // 5. Product from master card: exact price, local image.
    const created = await authed('post', '/api/v1/admin/products')
      .field('masterCardId', hit.id)
      .field('stock', '3')
      .expect(201);
    const linked = created.body as Admin;
    expect(linked).toMatchObject({
      isManual: false,
      autoSyncPrice: true,
      masterCardId: hit.id,
      priceUsd: hit.apiPriceUsd,
    });
    expect(linked.images[0].url).toMatch(/^\/uploads\/public\//);
    const again = await authed(
      'get',
      `/api/v1/admin/tcg-master-cards/search?q=${encodeURIComponent(`fake card ${SET(1)}`)}&limit=50`,
    ).expect(200);
    expect(
      (again.body as typeof sb).data.find((d) => d.id === hit.id)!
        .alreadyInInventory,
    ).toBe(true);

    // 6. Manual product (unchanged) + linked product with autoSync off.
    const category = await prisma.category.findFirstOrThrow();
    const manual = await authed('post', '/api/v1/admin/products')
      .field('name', 'E2E158 Manual')
      .field('slug', `${PREFIX}manual`)
      .field('description', 'd')
      .field('franchise', 'POKEMON')
      .field('productType', 'SINGLE_CARD')
      .field('rarity', 'COMMON')
      .field('stock', '1')
      .field('categoryId', category.id)
      .field('priceUsd', '9.99')
      .attach('images', IMAGE_FIXTURE)
      .expect(201);
    expect(manual.body).toMatchObject({
      isManual: true,
      autoSyncPrice: false,
      priceUsd: 9.99,
    });
    const frozen = (
      await authed('post', '/api/v1/admin/products')
        .field(
          'masterCardId',
          (
            await prisma.masterCard.findFirstOrThrow({
              where: { gameSlug: GAME, externalId: CARD(2, 1) },
            })
          ).id,
        )
        .field('stock', '1')
        .expect(201)
    ).body as Admin;
    await authed('patch', `/api/v1/admin/products/${frozen.id}`)
      .send({ autoSyncPrice: false })
      .expect(200);

    // 7. Nightly sync updates only the linked autoSync product.
    fake.setPrice(CARD(1, 1), 77.77);
    fake.setPrice(CARD(2, 1), 55.55);
    const res = await app.get(TcgNightlySyncService).runNightlySync();
    expect(['SUCCEEDED', 'PARTIAL']).toContain(res.status);
    const price = async (id: string) =>
      Number(
        (await prisma.product.findUniqueOrThrow({ where: { id } })).priceUsd,
      );
    expect(await price(linked.id)).toBe(77.77);
    expect(await price(frozen.id)).toBe(Number(frozen.priceUsd));
    expect(await price((manual.body as Admin).id)).toBe(9.99);
  });
});
