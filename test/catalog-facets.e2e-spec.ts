import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface Facet {
  id: string;
  name: string;
  slug: string;
  inStockCount: number;
  isActive: boolean;
}
interface Lang {
  code: string;
  name: string;
  inStockCount: number;
}
interface Totals {
  totalProducts: number;
  totalInStock: number;
  totalPreorder: number;
}
interface Facets {
  franchises: Facet[];
  formats: Facet[];
  languages: Lang[];
  totals: Totals;
}

const TEST_USERNAME = 'e2e-admin-story-13-7';
const TEST_EMAIL = 'e2e-admin-story-13-7@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-13a7';
const SEEDED_ROOT_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

// Story 13.7 (FR-52, AD-37): public catalog facets + Epic 13 end-to-end flow.
describe('Catalog facets (e2e, Story 13.7)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
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

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const facets = async (qs = ''): Promise<Facets> =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/catalog/facets${qs}`)
        .expect(200)
    ).body as Facets;
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${accessToken}`);

  async function mkCat(
    n: string,
    dimension: 'FRANCHISE' | 'SEALED_FORMAT',
    over: { parentId?: string; isActive?: boolean; sortOrder?: number } = {},
  ) {
    const c = await prisma.category.create({
      data: {
        name: `${tag}-${n}`,
        slug: `${tag}-${n}`.toLowerCase(),
        type: 'SUBCATEGORY',
        dimension,
        parentId: over.parentId ?? SEEDED_ROOT_ID,
        isActive: over.isActive ?? true,
        sortOrder: over.sortOrder ?? 0,
      },
    });
    categoryIds.push(c.id);
    return c.id;
  }

  async function mkProd(
    n: string,
    o: {
      stock?: number;
      heldQty?: number;
      isActive?: boolean;
      isPreorder?: boolean;
      productType?: 'BOOSTER_BOX' | 'SINGLE_CARD';
      lang?: 'JP' | 'EN' | 'ES' | 'CN' | 'OTHER';
      tags: string[];
    },
  ) {
    const p = await prisma.product.create({
      data: {
        name: `${tag}-${n}`,
        slug: `${tag}-${n}`.toLowerCase(),
        description: 'x',
        franchise: 'OTHER',
        productType: o.productType ?? 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: 1,
        stock: o.stock ?? 5,
        heldQty: o.heldQty ?? 0,
        isActive: o.isActive ?? true,
        isPreorder: o.isPreorder ?? false,
        editionLanguage: o.lang ?? 'EN',
        categoryId: SEEDED_ROOT_ID,
        taxonomyTags: {
          create: o.tags.map((categoryId) => ({ categoryId })),
        },
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  const find = (list: Facet[], id: string) => list.find((f) => f.id === id);

  it('AC1/2/3/4/5/6/8: counts, ordering, exclusions, macro, totals', async () => {
    const before = await facets();
    const beforeSealed = await facets('?macroCategory=SEALED');
    const beforeSingles = await facets('?macroCategory=SINGLES');

    const fA = await mkCat('fa', 'FRANCHISE', { sortOrder: -2000 });
    const fB = await mkCat('fb', 'FRANCHISE', { sortOrder: -1999 });
    const fEmpty = await mkCat('fe', 'FRANCHISE', { sortOrder: -1998 });
    const fInactive = await mkCat('fi', 'FRANCHISE', { isActive: false });
    const fUnderInactive = await mkCat('fu', 'FRANCHISE', {
      parentId: fInactive,
    });
    const fmt = await mkCat('fmt', 'SEALED_FORMAT', { sortOrder: -2000 });

    await mkProd('held', { stock: 5, heldQty: 5, tags: [fA] }); // not in stock
    await mkProd('free', { stock: 5, heldQty: 2, tags: [fA, fmt] });
    await mkProd('inactive', {
      stock: 9,
      isActive: false,
      tags: [fA, fB, fInactive],
    });
    await mkProd('single', {
      stock: 2,
      productType: 'SINGLE_CARD',
      lang: 'JP',
      isPreorder: true,
      tags: [fB, fUnderInactive, fInactive],
    });

    const after = await facets();
    expect(Object.keys(after).sort()).toEqual([
      'formats',
      'franchises',
      'languages',
      'totals',
    ]);
    expect(find(after.franchises, fA)).toMatchObject({
      inStockCount: 1,
      isActive: true,
    });
    expect(find(after.franchises, fB)?.inStockCount).toBe(1);
    expect(find(after.franchises, fEmpty)?.inStockCount).toBe(0);
    expect(find(after.franchises, fInactive)).toBeUndefined();
    expect(find(after.franchises, fUnderInactive)).toBeUndefined();
    expect(find(after.formats, fmt)?.inStockCount).toBe(1);
    expect(find(after.franchises, fmt)).toBeUndefined();
    // ordering by sortOrder, name
    const mine = after.franchises
      .filter((f) => [fA, fB, fEmpty].includes(f.id))
      .map((f) => f.id);
    expect(mine).toEqual([fA, fB, fEmpty]);
    // seeded taxonomy: SINGLE_CARD never listed as a format
    expect(after.formats.some((f) => /single/i.test(f.slug))).toBe(false);
    // totals: 3 active products added (inactive one counts nowhere)
    expect(after.totals.totalProducts - before.totals.totalProducts).toBe(3);
    expect(after.totals.totalInStock - before.totals.totalInStock).toBe(2);
    expect(after.totals.totalPreorder - before.totals.totalPreorder).toBe(1);
    expect(after.languages.map((l) => l.code)).toEqual(
      expect.arrayContaining(['EN', 'JP']),
    );
    const order = ['ES', 'EN', 'JP', 'CN', 'OTHER'];
    const idx = after.languages.map((l) => order.indexOf(l.code));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(after.languages.find((l) => l.code === 'JP')?.name).toBe('Japonés');

    // macro restriction
    const sealed = await facets('?macroCategory=SEALED');
    expect(
      sealed.totals.totalProducts - beforeSealed.totals.totalProducts,
    ).toBe(2);
    expect(find(sealed.franchises, fB)?.inStockCount).toBe(0); // only single in stock
    expect(find(sealed.franchises, fB)).toBeDefined(); // kept at 0 (JOIN filter)
    expect(find(sealed.franchises, fA)?.inStockCount).toBe(1);
    const singles = await facets('?macroCategory=SINGLES');
    expect(
      singles.totals.totalProducts - beforeSingles.totals.totalProducts,
    ).toBe(1);
    expect(find(singles.franchises, fB)?.inStockCount).toBe(1);
    expect(find(singles.franchises, fA)?.inStockCount).toBe(0);
    expect(find(singles.formats, fmt)?.inStockCount).toBe(0);
  });

  it('AC7: languages omit codes with no active product', async () => {
    const before = await facets();
    const hadCN = before.languages.some((l) => l.code === 'CN');
    await mkProd('cn-inactive', { lang: 'CN', isActive: false, tags: [] });
    const after = await facets();
    expect(after.languages.some((l) => l.code === 'CN')).toBe(hadCN);
  });

  it('AC9: facets agree with GET /products?onlyInStock=true', async () => {
    const f = await mkCat('co', 'FRANCHISE');
    await mkProd('co1', { stock: 3, tags: [f] });
    await mkProd('co2', { stock: 1, heldQty: 1, tags: [f] });
    const res = await facets();
    const listed = await request(app.getHttpServer())
      .get(`/api/v1/products?categoryId=${f}&onlyInStock=true`)
      .expect(200);
    expect(find(res.franchises, f)?.inStockCount).toBe(
      (listed.body as { meta: { total: number } }).meta.total,
    );
  });

  it('AC11: invalid/malformed params', async () => {
    const http = () => request(app.getHttpServer());
    await http()
      .get("/api/v1/catalog/facets?macroCategory=SEALED'--")
      .expect(400);
    await http().get('/api/v1/catalog/facets?macroCategory=NOPE').expect(400);
    await http()
      .get('/api/v1/catalog/facets?macroCategory=SEALED&macroCategory=SINGLES')
      .expect(400);
    await http().get('/api/v1/catalog/facets?unknown=1').expect(200);
    await http().get('/api/v1/categories').expect(200);
  });

  it('AC12: swagger documents the endpoint', async () => {
    const doc = (
      await request(app.getHttpServer()).get('/api/docs-json').expect(200)
    ).body as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: { name: string }[];
            responses: Record<
              string,
              { content?: Record<string, { schema: { $ref?: string } }> }
            >;
          }
        >
      >;
    };
    const op = doc.paths['/api/v1/catalog/facets'].get;
    expect(op.parameters?.map((p) => p.name)).toContain('macroCategory');
    expect(op.responses['400']).toBeDefined();
    expect(
      op.responses['200'].content?.['application/json'].schema.$ref,
    ).toContain('CatalogFacetsResponseDto');
  });

  it('AC14: admin flow Lorcana end to end', async () => {
    const create = await auth(
      request(app.getHttpServer()).post('/api/v1/admin/categories'),
    )
      .send({
        name: `Lorcana ${tag}`,
        slug: `lorcana-${tag}`.toLowerCase(),
        type: 'SUBCATEGORY',
        dimension: 'FRANCHISE',
        parentId: SEEDED_ROOT_ID,
      })
      .expect(201);
    const lorcana = (create.body as { id: string }).id;
    categoryIds.push(lorcana);

    const pr = await auth(
      request(app.getHttpServer()).post('/api/v1/admin/products'),
    )
      .field('name', `Lorcana box ${tag}`)
      .field('slug', `lorcana-box-${tag}`.toLowerCase())
      .field('description', 'Created by e2e.')
      .field('franchise', 'OTHER')
      .field('productType', 'BOOSTER_BOX')
      .field('rarity', 'COMMON')
      .field('priceUsd', '9.99')
      .field('stock', '3')
      .field('editionLanguage', 'JP')
      .field('categoryId', SEEDED_ROOT_ID)
      .field('categoryIds', JSON.stringify([lorcana]))
      .attach('images', IMAGE_FIXTURE_PATH)
      .expect(201);
    const productId = (pr.body as { id: string }).id;
    productIds.push(productId);

    const f = await facets();
    expect(find(f.franchises, lorcana)?.inStockCount).toBe(1);
    expect(f.languages.some((l) => l.code === 'JP')).toBe(true);
    const list = await request(app.getHttpServer())
      .get(`/api/v1/products?categoryId=${lorcana}&language=JP`)
      .expect(200);
    expect((list.body as { data: { id: string }[] }).data[0].id).toBe(
      productId,
    );

    const del = await auth(
      request(app.getHttpServer()).delete(
        `/api/v1/admin/categories/${lorcana}`,
      ),
    ).expect(409);
    expect((del.body as { errorCode: string }).errorCode).toBe(
      'CATEGORY_IN_USE',
    );

    await auth(
      request(app.getHttpServer()).patch(`/api/v1/admin/categories/${lorcana}`),
    )
      .send({ isActive: false })
      .expect(200);
    expect(find((await facets()).franchises, lorcana)).toBeUndefined();
    const cats = (
      await request(app.getHttpServer()).get('/api/v1/categories').expect(200)
    ).body as { id: string }[];
    expect(cats.some((c) => c.id === lorcana)).toBe(false);
    const still = await request(app.getHttpServer())
      .get(`/api/v1/products?categoryId=${lorcana}`)
      .expect(200);
    expect(
      (still.body as { data: { id: string }[] }).data.map((d) => d.id),
    ).toContain(productId);
  });
});
