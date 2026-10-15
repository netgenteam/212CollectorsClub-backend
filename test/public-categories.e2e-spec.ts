import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface Cat {
  id: string;
  name: string;
  slug: string;
  type: string;
  dimension: string | null;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  _count?: unknown;
}

const PREFIX = 'e2e133-';

/**
 * Story 13.3 (FR-47; AD-35). Public categories listing with taxonomy
 * filters. Rows are inserted directly via Prisma (prefix `e2e133-`) and
 * removed after each test.
 */
describe('Public categories listing (e2e, Story 13.3)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.category.updateMany({
      where: { slug: { startsWith: PREFIX } },
      data: { parentId: null },
    });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await app.close();
  });

  async function mk(
    name: string,
    extra: {
      type?: 'ROOT' | 'SUBCATEGORY';
      dimension?: 'FRANCHISE' | 'SEALED_FORMAT' | 'EDITION_LANGUAGE' | 'CUSTOM';
      parentId?: string;
      isActive?: boolean;
      sortOrder?: number;
    } = {},
  ) {
    return prisma.category.create({
      data: {
        name,
        slug: `${PREFIX}${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 6)}`,
        ...extra,
      },
    });
  }

  const list = (qs = '') =>
    request(app.getHttpServer()).get(`/api/v1/categories${qs}`);
  const mine = (body: unknown) =>
    (body as Cat[]).filter((c) => c.slug.startsWith(PREFIX));

  it('AC1: items carry the taxonomy fields and never _count', async () => {
    await mk('Alpha');
    const res = await list().expect(200);
    const item = mine(res.body)[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'dimension',
        'id',
        'isActive',
        'name',
        'parentId',
        'slug',
        'sortOrder',
        'type',
      ].sort(),
    );
    expect(item._count).toBeUndefined();
  });

  it('AC2: hides inactive and orders by sortOrder then name', async () => {
    await mk('Zeta', { sortOrder: -5 });
    await mk('Bravo', { sortOrder: -5 });
    await mk('Alpha', { sortOrder: -4 });
    await mk('Hidden', { sortOrder: -9, isActive: false });
    const names = mine((await list().expect(200)).body).map((c) => c.name);
    expect(names).toEqual(['Bravo', 'Zeta', 'Alpha']);
  });

  it('AC3: hides active categories under an inactive ancestor, products stay', async () => {
    const root = await mk('Root A');
    const mid = await mk('Mid A', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: root.id,
    });
    const leaf = await mk('Leaf A', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: mid.id,
    });
    const product = await prisma.product.create({
      data: {
        name: 'E2E prod',
        slug: `${PREFIX}prod-${randomUUID().slice(0, 6)}`,
        description: 'x',
        franchise: 'POKEMON',
        productType: 'BOOSTER_PACK',
        rarity: 'COMMON',
        priceUsd: 1,
        stock: 1,
        categoryId: leaf.id,
      },
    });
    expect(mine((await list().expect(200)).body)).toHaveLength(3);

    await prisma.category.update({
      where: { id: root.id },
      data: { isActive: false },
    });
    expect(mine((await list().expect(200)).body)).toHaveLength(0);
    const prods = await request(app.getHttpServer())
      .get('/api/v1/products')
      .query({ categoryId: leaf.id })
      .expect(200);
    expect(
      (prods.body as { data: { id: string }[] }).data.map((p) => p.id),
    ).toContain(product.id);

    await prisma.category.update({
      where: { id: root.id },
      data: { isActive: true },
    });
    expect(mine((await list().expect(200)).body)).toHaveLength(3);
  });

  it('AC4: filters by type; invalid gives 400', async () => {
    const root = await mk('Root B');
    await mk('Sub B', {
      type: 'SUBCATEGORY',
      dimension: 'FRANCHISE',
      parentId: root.id,
    });
    const roots = mine((await list('?type=ROOT').expect(200)).body);
    expect(roots.map((c) => c.type)).toEqual(['ROOT']);
    const subs = mine((await list('?type=SUBCATEGORY').expect(200)).body);
    expect(subs.map((c) => c.type)).toEqual(['SUBCATEGORY']);
    await list('?type=NOPE').expect(400);
  });

  it('AC5: filters by dimension; invalid gives 400', async () => {
    const root = await mk('Root C');
    for (const dimension of [
      'FRANCHISE',
      'SEALED_FORMAT',
      'EDITION_LANGUAGE',
      'CUSTOM',
    ] as const) {
      await mk(`Sub ${dimension}`, {
        type: 'SUBCATEGORY',
        dimension,
        parentId: root.id,
      });
    }
    for (const dimension of [
      'FRANCHISE',
      'SEALED_FORMAT',
      'EDITION_LANGUAGE',
      'CUSTOM',
    ]) {
      const got = mine(
        (await list(`?dimension=${dimension}`).expect(200)).body,
      );
      expect(got).toHaveLength(1);
      expect(got[0].dimension).toBe(dimension);
    }
    await list('?dimension=nope').expect(400);
  });

  it('AC6: parentId returns direct children only; unknown 200 empty; non-uuid 400', async () => {
    const root = await mk('Root D');
    const child = await mk('Child D', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: root.id,
    });
    await mk('Grandchild D', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: child.id,
    });
    const res = await list(`?parentId=${root.id}`).expect(200);
    expect((res.body as Cat[]).map((c) => c.id)).toEqual([child.id]);
    const none = await list(`?parentId=${randomUUID()}`).expect(200);
    expect(none.body).toEqual([]);
    await list('?parentId=not-a-uuid').expect(400);
  });

  it('AC7: filters AND together; repeated enum is 400; unknown params ignored', async () => {
    const root = await mk('Root E');
    const a = await mk('Sub E1', {
      type: 'SUBCATEGORY',
      dimension: 'FRANCHISE',
      parentId: root.id,
    });
    await mk('Sub E2', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: root.id,
    });
    const res = await list(
      `?type=SUBCATEGORY&dimension=FRANCHISE&parentId=${root.id}`,
    ).expect(200);
    expect((res.body as Cat[]).map((c) => c.id)).toEqual([a.id]);
    await list('?type=ROOT&type=SUBCATEGORY').expect(400);
    await list('?foo=bar').expect(200);
  });

  it('AC8: malicious values give 400 and the table is intact', async () => {
    await list(
      `?dimension=${encodeURIComponent("FRANCHISE' OR '1'='1")}`,
    ).expect(400);
    await list(
      `?parentId=${encodeURIComponent('1;DROP TABLE "Categories"')}`,
    ).expect(400);
    await list(`?type=${'A'.repeat(5000)}`).expect(400);
    await list(`?parentId=${'1'.repeat(5000)}`).expect(400);
    expect(await prisma.category.count()).toBeGreaterThan(0);
  });

  it('AC9: a parent cycle does not hang the request', async () => {
    const root = await mk('Cycle Root');
    const a = await mk('Cycle A', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: root.id,
    });
    const b = await mk('Cycle B', {
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: a.id,
    });
    await prisma.category.update({
      where: { id: a.id },
      data: { parentId: b.id },
    });
    const res = await list().expect(200);
    expect(mine(res.body).map((c) => c.id)).toEqual([root.id]);
  });

  it('AC10: same 200 with a bogus bearer token', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(200);
  });
});
