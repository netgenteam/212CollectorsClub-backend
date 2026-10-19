import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface Child {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  inStockCount: number;
}
interface Group extends Child {
  children: Child[];
}
interface Facets {
  franchises: unknown[];
  formats: unknown[];
  languages: unknown[];
  totals: unknown;
  categoryGroups: Group[];
}

// Story 14.2 (FR-55, AD-43): hierarchical categoryGroups in catalog facets.
describe('Catalog facets categoryGroups (e2e, Story 14.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
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
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    // children before parents (self-relation is ON DELETE RESTRICT)
    for (const id of [...categoryIds].reverse()) {
      await prisma.category.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  const facets = async (qs = ''): Promise<Facets> =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/catalog/facets${qs}`)
        .expect(200)
    ).body as Facets;

  async function mkRoot(n: string, sortOrder = -3000, isActive = true) {
    const c = await prisma.category.create({
      data: {
        name: `${tag}-${n}`,
        slug: `${tag}-${n}`.toLowerCase(),
        type: 'ROOT',
        sortOrder,
        isActive,
      },
    });
    categoryIds.push(c.id);
    return c.id;
  }
  async function mkSub(
    n: string,
    parentId: string,
    over: { sortOrder?: number; isActive?: boolean } = {},
  ) {
    const c = await prisma.category.create({
      data: {
        name: `${tag}-${n}`,
        slug: `${tag}-${n}`.toLowerCase(),
        type: 'SUBCATEGORY',
        parentId,
        sortOrder: over.sortOrder ?? 0,
        isActive: over.isActive ?? true,
      },
    });
    categoryIds.push(c.id);
    return c.id;
  }
  async function mkProd(
    n: string,
    categoryId: string,
    o: {
      stock?: number;
      heldQty?: number;
      isActive?: boolean;
      productType?: 'BOOSTER_BOX' | 'SINGLE_CARD';
      tags?: string[];
    } = {},
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
        editionLanguage: 'EN',
        categoryId,
        taxonomyTags: {
          create: (o.tags ?? []).map((c) => ({ categoryId: c })),
        },
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  const group = (f: Facets, id: string) =>
    f.categoryGroups.find((g) => g.id === id);

  const productsTotal = async (id: string, qs = '') =>
    (
      (
        await request(app.getHttpServer())
          .get(`/api/v1/products?categoryId=${id}&onlyInStock=true${qs}`)
          .expect(200)
      ).body as { meta: { total: number } }
    ).meta.total;

  async function expectConsistent(qs = '', macro = '') {
    const f = await facets(qs);
    let checked = 0;
    for (const g of f.categoryGroups) {
      expect(g.inStockCount).toBe(await productsTotal(g.id, macro));
      for (const c of g.children) {
        expect(c.inStockCount).toBe(await productsTotal(c.id, macro));
        checked++;
      }
      checked++;
    }
    return checked;
  }

  let rootA: string;
  let childA1: string;
  let childA2: string;
  let childEmpty: string;
  let grand: string;

  it('AC1-6: groups, order, cascade, counts, stock and macro', async () => {
    rootA = await mkRoot('ra', -3000);
    const rootB = await mkRoot('rb', -2999);
    const rootInactive = await mkRoot('ri', -2998, false);
    const rootNoKids = await mkRoot('rn', -2997);
    const rootAllInactive = await mkRoot('rx', -2996);

    childA2 = await mkSub('a2', rootA, { sortOrder: 1 });
    childA1 = await mkSub('a1', rootA, { sortOrder: 0 });
    childEmpty = await mkSub('ae', rootA, { sortOrder: 2 });
    const childInactive = await mkSub('ai', rootA, {
      sortOrder: 3,
      isActive: false,
    });
    grand = await mkSub('g', childA1);
    const childB = await mkSub('b1', rootB);
    const underInactiveRoot = await mkSub('ui', rootInactive);
    const onlyInactiveKid = await mkSub('xi', rootAllInactive, {
      isActive: false,
    });

    // principal on child, grandchild-only, tag-only, principal+tag (dup),
    // two children (dup at root), held-out, inactive product
    await mkProd('p-a1', childA1);
    await mkProd('p-grand', grand);
    await mkProd('p-tag', rootNoKids, { tags: [childA2] });
    await mkProd('p-dup', childA1, { tags: [childA1] });
    await mkProd('p-two', childA1, { tags: [childA2] });
    await mkProd('p-held', childA1, { stock: 5, heldQty: 5 });
    await mkProd('p-partial', childA2, { stock: 5, heldQty: 2 });
    await mkProd('p-inactive', childA1, { isActive: false });
    await mkProd('p-single', childB, { productType: 'SINGLE_CARD' });
    await mkProd('p-ui', underInactiveRoot);
    await mkProd('p-xi', onlyInactiveKid);
    await mkProd('p-inactive-child', childInactive);

    const f = await facets();
    expect(Object.keys(f)).toEqual(
      expect.arrayContaining([
        'franchises',
        'formats',
        'languages',
        'totals',
        'categoryGroups',
      ]),
    );
    // cascade hiding (AC3)
    expect(group(f, rootInactive)).toBeUndefined();
    expect(group(f, rootNoKids)).toBeUndefined();
    expect(group(f, rootAllInactive)).toBeUndefined();
    const flatChildIds = f.categoryGroups.flatMap((g) =>
      g.children.map((c) => c.id),
    );
    for (const hidden of [childInactive, underInactiveRoot, onlyInactiveKid]) {
      expect(flatChildIds).not.toContain(hidden);
    }
    // order (AC2): roots then children by sortOrder, name
    const mine = f.categoryGroups
      .filter((g) => [rootA, rootB].includes(g.id))
      .map((g) => g.id);
    expect(mine).toEqual([rootA, rootB]);
    const gA = group(f, rootA)!;
    expect(gA.children.map((c) => c.id)).toEqual([
      childA1,
      childA2,
      childEmpty,
    ]);
    expect(gA).toMatchObject({ name: `${tag}-ra`, sortOrder: -3000 });
    // counts (AC4/AC5)
    // childA1: p-a1, p-grand (via grandchild), p-dup, p-two = 4
    expect(gA.children[0].inStockCount).toBe(4);
    // childA2: p-tag, p-two (tag), p-partial = 3
    expect(gA.children[1].inStockCount).toBe(3);
    expect(gA.children[2].inStockCount).toBe(0);
    // root: distinct union = a1(4) + p-tag + p-partial + p-inactive-child
    // (inactive descendants still count, AD-36) = 7; p-two counted once
    expect(gA.inStockCount).toBe(7);
    expect(group(f, rootB)!.inStockCount).toBe(1);

    // consistency vs /products (AC4) incl. macro (AC6)
    expect(await expectConsistent()).toBeGreaterThanOrEqual(6);
    await expectConsistent('?macroCategory=SEALED', '&macroCategory=SEALED');
    await expectConsistent('?macroCategory=SINGLES', '&macroCategory=SINGLES');
    const sealed = await facets('?macroCategory=SEALED');
    const singles = await facets('?macroCategory=SINGLES');
    expect(group(sealed, rootB)!.inStockCount).toBe(0);
    expect(group(sealed, rootB)!.children[0].inStockCount).toBe(0);
    expect(group(singles, rootB)!.inStockCount).toBe(1);
    expect(group(singles, rootA)!.inStockCount).toBe(0);

    await request(app.getHttpServer())
      .get('/api/v1/catalog/facets?macroCategory=NOPE')
      .expect(400);
  });

  it('AC7: stays consistent and successful under concurrent holds', async () => {
    const pid = await mkProd('p-hold', childA1, { stock: 10 });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => facets()),
      prisma.product.update({ where: { id: pid }, data: { heldQty: 10 } }),
    ]);
    expect((results[0] as Facets).categoryGroups).toBeInstanceOf(Array);
    expect(await expectConsistent()).toBeGreaterThan(0);
  });

  it('AC9: swagger documents CategoryGroupDto with array children', async () => {
    const doc = (
      await request(app.getHttpServer()).get('/api/docs-json').expect(200)
    ).body as {
      components: {
        schemas: Record<
          string,
          {
            properties: Record<
              string,
              { type?: string; items?: { $ref?: string; type?: string } }
            >;
          }
        >;
      };
    };
    const s = doc.components.schemas;
    expect(Object.keys(s.CategoryGroupDto.properties).sort()).toEqual([
      'children',
      'id',
      'inStockCount',
      'name',
      'slug',
      'sortOrder',
    ]);
    expect(s.CategoryGroupDto.properties.children).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/CategoryGroupChildDto' },
    });
    expect(Object.keys(s.CategoryGroupChildDto.properties).sort()).toEqual([
      'id',
      'inStockCount',
      'name',
      'slug',
      'sortOrder',
    ]);
    expect(s.CatalogFacetsResponseDto.properties.categoryGroups).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/CategoryGroupDto' },
    });
  });
});
