import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import type {
  Franchise,
  ProductType,
} from './../src/generated/prisma/enums.js';

interface Item {
  id: string;
  name: string;
  availableStock: number;
}

// Story 11.3 (FR-33): GET /products/:id/related.
describe('Related products (e2e, Story 11.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdIds: string[] = [];
  const token = `Rlt${randomUUID().slice(0, 6)}`;
  let categoryId: string;
  let otherCategoryId: string;
  const ids: Record<string, string> = {};

  const mk = async (
    key: string,
    o: {
      franchise: Franchise;
      productType: ProductType;
      stock: number;
      cat?: string;
      isActive?: boolean;
    },
  ) => {
    const p = await prisma.product.create({
      data: {
        name: `${token} ${key}`,
        slug: `${token.toLowerCase()}-${key}`,
        description: 'Created by e2e 11.3.',
        franchise: o.franchise,
        productType: o.productType,
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock: o.stock,
        heldQty: 0,
        isActive: o.isActive ?? true,
        categoryId: o.cat ?? categoryId,
      },
    });
    createdIds.push(p.id);
    ids[key] = p.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    categoryId = (
      await prisma.category.create({
        data: { name: `${token} cat`, slug: `${token.toLowerCase()}-cat` },
      })
    ).id;
    otherCategoryId = (
      await prisma.category.create({
        data: { name: `${token} cat2`, slug: `${token.toLowerCase()}-cat2` },
      })
    ).id;

    // Base: NARUTO sealed in own category.
    await mk('base', {
      franchise: 'NARUTO',
      productType: 'BOOSTER_BOX',
      stock: 5,
    });
    // Strong match (same franchise + macro) but out of stock, other category.
    await mk('strongoos', {
      franchise: 'NARUTO',
      productType: 'BOOSTER_PACK',
      stock: 0,
      cat: otherCategoryId,
    });
    // Same category only (other franchise), in stock.
    await mk('catinstock', {
      franchise: 'TOPPS',
      productType: 'SINGLE_CARD',
      stock: 3,
    });
    // Strong match, in stock.
    await mk('stronginstock', {
      franchise: 'NARUTO',
      productType: 'STARTER_DECK',
      stock: 2,
      cat: otherCategoryId,
    });
    // Inactive strong match: must never appear.
    await mk('inactive', {
      franchise: 'NARUTO',
      productType: 'BOOSTER_BOX',
      stock: 9,
      isActive: false,
    });
    // Unrelated (other franchise, other category).
    await mk('unrelated', {
      franchise: 'TOPPS',
      productType: 'BOOSTER_BOX',
      stock: 9,
      cat: otherCategoryId,
    });
    // Isolated product: unique category, franchise+type combination with no
    // peers (SINGLE_CARD NARUTO has no seeded rows).
    const lonelyCat = await prisma.category.create({
      data: { name: `${token} lonely`, slug: `${token.toLowerCase()}-lonely` },
    });
    await mk('lonely', {
      franchise: 'NARUTO',
      productType: 'SINGLE_CARD',
      stock: 1,
      cat: lonelyCat.id,
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: token.toLowerCase() } },
    });
    await app.close();
  });

  const related = (id: string, qs = '') =>
    request(app.getHttpServer()).get(`/api/v1/products/${id}/related${qs}`);
  const mine = (items: Item[]) =>
    items
      .filter((i) => i.name.startsWith(token))
      .map((i) => i.name.slice(token.length + 1));

  it('ranks in-stock first, then strong match, then category; excludes self and inactive', async () => {
    const res = await related(ids.base, '?limit=10').expect(200);
    const body = res.body as { data: Item[]; meta?: unknown };
    expect(body.meta).toBeUndefined();
    const names = mine(body.data);
    expect(names).toEqual(['stronginstock', 'catinstock', 'strongoos']);
    expect(body.data.some((i) => i.id === ids.base)).toBe(false);
    expect(body.data.some((i) => i.id === ids.inactive)).toBe(false);
    // in-stock block precedes out-of-stock block
    const stocks = body.data.map((i) => i.availableStock > 0);
    expect(stocks).toEqual([...stocks].sort((a, b) => Number(b) - Number(a)));
  });

  it('defaults to limit 4 and honors limit', async () => {
    const def = (await related(ids.base).expect(200)).body as { data: Item[] };
    expect(def.data.length).toBeLessThanOrEqual(4);
    const one = (await related(ids.base, '?limit=1').expect(200)).body as {
      data: Item[];
    };
    expect(one.data).toHaveLength(1);
  });

  it('400 for a non-UUID id and for limit 0 / 11', async () => {
    await related('not-a-uuid').expect(400);
    await related(ids.base, '?limit=0').expect(400);
    await related(ids.base, '?limit=11').expect(400);
  });

  it('404 for a missing or inactive product', async () => {
    const missing = await related(randomUUID()).expect(404);
    const inactive = await related(ids.inactive).expect(404);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/products/${randomUUID()}`)
      .expect(404);
    expect(Object.keys(missing.body as object).sort()).toEqual(
      Object.keys(detail.body as object).sort(),
    );
    expect(inactive.status).toBe(404);
  });

  it('200 with data [] when nothing is related', async () => {
    const res = await related(ids.lonely).expect(200);
    expect(res.body).toEqual({ data: [] });
  });

  it('keeps the product detail route working', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/products/${ids.base}`)
      .expect(200);
    expect((res.body as { id: string }).id).toBe(ids.base);
  });
});
