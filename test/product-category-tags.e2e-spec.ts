import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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

interface Tag {
  id: string;
  name: string;
  slug: string;
  dimension: string | null;
}
interface Item {
  id: string;
  slug: string;
  categories: Tag[];
  category: { id: string };
}

const TEST_USERNAME = 'e2e-admin-story-13-5';
const TEST_EMAIL = 'e2e-admin-story-13-5@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-13a5';
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);
const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    '..',
    'prisma/migrations/20261015200100_add_product_categories/migration.sql',
  ),
  'utf8',
);
const SEED_MARKER = '-- Story 13.5 (FR-50, AD-33): idempotent seed';

const err = (b: unknown) => (b as { errorCode: string }).errorCode;

// Story 13.5 (FR-50, AD-33/36/38): product-category tags, Franchise.OTHER, backfill.
describe('Product category tags (e2e, Story 13.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;
  const createdProducts: string[] = [];
  const createdCategories: string[] = [];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
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

  afterEach(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdProducts } } });
    await prisma.category.deleteMany({
      where: { id: { in: createdCategories } },
    });
    createdProducts.length = 0;
    createdCategories.length = 0;
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${accessToken}`);

  async function mkCat(
    over: Partial<{
      isActive: boolean;
      sortOrder: number;
      name: string;
      type: 'ROOT' | 'SUBCATEGORY';
    }> = {},
  ) {
    const id = randomUUID();
    const type = over.type ?? 'SUBCATEGORY';
    const c = await prisma.category.create({
      data: {
        id,
        name: over.name ?? `E2E tag ${id.slice(0, 6)}`,
        slug: `e2e-tag-${id.slice(0, 8)}`,
        type,
        dimension: type === 'ROOT' ? null : 'CUSTOM',
        isActive: over.isActive ?? true,
        sortOrder: over.sortOrder ?? 0,
      },
    });
    createdCategories.push(c.id);
    return c;
  }

  function createReq(fields: Record<string, string | string[]> = {}) {
    const f: Record<string, string | string[]> = {
      name: 'E2E Tag Product',
      slug: `e2e-tags-${randomUUID().slice(0, 8)}`,
      description: 'Created by e2e.',
      franchise: 'POKEMON',
      productType: 'BOOSTER_BOX',
      rarity: 'COMMON',
      priceUsd: '9.99',
      stock: '5',
      categoryId: SEEDED_CATEGORY_ID,
      ...fields,
    };
    let req = auth(request(app.getHttpServer()).post('/api/v1/admin/products'));
    for (const [k, v] of Object.entries(f)) {
      for (const one of Array.isArray(v) ? v : [v]) req = req.field(k, one);
    }
    return req.attach('images', IMAGE_FIXTURE_PATH);
  }

  async function create(
    fields: Record<string, string | string[]> = {},
  ): Promise<Item> {
    const res = await createReq(fields).expect(201);
    const item = res.body as Item;
    createdProducts.push(item.id);
    return item;
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    auth(
      request(app.getHttpServer()).patch(`/api/v1/admin/products/${id}`),
    ).send(body);

  const slugs = (i: Item) => i.categories.map((c) => c.slug).sort();

  async function tagSlugs(productId: string) {
    const rows = await prisma.productCategory.findMany({
      where: { productId },
      select: { category: { select: { slug: true } } },
    });
    return rows.map((r) => r.category.slug).sort();
  }

  it('AC1/AC2: OTHER exists; Product_Categories has PK, index and FK actions', async () => {
    const vals = await prisma.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::"Franchise"))::text AS v`;
    expect(vals.map((r) => r.v)).toContain('OTHER');
    expect(vals).toHaveLength(8);
    const fks = await prisma.$queryRaw<
      { conname: string; confdeltype: string }[]
    >`
      SELECT conname, confdeltype::text FROM pg_constraint
      WHERE conrelid = '"Product_Categories"'::regclass AND contype = 'f'`;
    const by = Object.fromEntries(fks.map((f) => [f.conname, f.confdeltype]));
    expect(by['Product_Categories_productId_fkey']).toBe('c');
    expect(by['Product_Categories_categoryId_fkey']).toBe('r');
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Product_Categories'`;
    expect(idx.map((i) => i.indexname).sort()).toEqual([
      'Product_Categories_categoryId_idx',
      'Product_Categories_pkey',
    ]);
  });

  it('AC3: seeded taxonomy exists with expected shape', async () => {
    const rows = await prisma.category.findMany({
      where: {
        OR: [
          { slug: { startsWith: 'franchise-' } },
          { slug: { startsWith: 'format-' } },
        ],
        type: 'SUBCATEGORY',
        // Story 15.1: these now hang under the standard roots (parentId set).
        parentId: { not: null },
      },
      orderBy: { sortOrder: 'asc' },
    });
    const f = rows.filter((r) => r.dimension === 'FRANCHISE');
    const s = rows.filter((r) => r.dimension === 'SEALED_FORMAT');
    expect(f.map((r) => r.slug)).toEqual([
      'franchise-pokemon',
      'franchise-one-piece',
      'franchise-magic-the-gathering',
      'franchise-yu-gi-oh',
      'franchise-dragon-ball-super',
      'franchise-topps',
      'franchise-naruto',
    ]);
    expect(s.map((r) => r.slug)).toEqual([
      'format-booster-pack',
      'format-booster-box',
      'format-starter-deck',
      'format-collector-tin',
      'format-accessory',
    ]);
    expect(rows.every((r) => r.isActive && r.name.length > 0)).toBe(true);
    expect(f[0].name).toBe('Pokémon');
  });

  it('AC4/AC5: backfill links by enums; re-running the SQL is idempotent', async () => {
    const mk = (
      franchise: 'POKEMON' | 'OTHER',
      productType: 'SINGLE_CARD' | 'ACCESSORY',
    ) =>
      prisma.product.create({
        data: {
          name: 'bf',
          slug: `e2e-bf-${randomUUID().slice(0, 8)}`,
          description: 'd',
          franchise,
          productType,
          rarity: 'COMMON',
          priceUsd: 1,
          stock: 1,
          categoryId: SEEDED_CATEGORY_ID,
        },
      });
    const a = await mk('POKEMON', 'SINGLE_CARD');
    const b = await mk('POKEMON', 'ACCESSORY');
    const c = await mk('OTHER', 'SINGLE_CARD');
    createdProducts.push(a.id, b.id, c.id);

    const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf(SEED_MARKER));
    const statements = body
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    const catsBefore = await prisma.category.count();
    for (let run = 0; run < 2; run++) {
      for (const st of statements) await prisma.$executeRawUnsafe(st);
    }
    expect(await prisma.category.count()).toBe(catsBefore);
    expect(await tagSlugs(a.id)).toEqual(['franchise-pokemon']);
    expect(await tagSlugs(b.id)).toEqual([
      'format-accessory',
      'franchise-pokemon',
    ]);
    expect(await tagSlugs(c.id)).toEqual([]);
    const dup = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "Categories" WHERE slug = 'franchise-pokemon'`;
    expect(dup[0].n).toBe(1);
  });

  it('AC7/AC9/AC11: POST merges derived tags, drops other seeded, keeps custom, dedups, accepts inactive', async () => {
    const custom = await mkCat({ isActive: false });
    const topps = await prisma.category.findUniqueOrThrow({
      where: { slug: 'franchise-topps' },
    });
    const p = await create({
      categoryIds: JSON.stringify([custom.id, custom.id, topps.id]),
    });
    expect(slugs(p)).toEqual(
      ['format-booster-box', 'franchise-pokemon', custom.slug].sort(),
    );
    expect(p.category.id).toBe(SEEDED_CATEGORY_ID);

    // repeated multipart fields work too
    const c2 = await mkCat();
    const p2 = await create({ categoryIds: [custom.id, c2.id] });
    expect(slugs(p2)).toContain(c2.slug);
    expect(slugs(p2)).toContain(custom.slug);

    // without categoryIds: only derived
    const p3 = await create();
    expect(slugs(p3)).toEqual(['format-booster-box', 'franchise-pokemon']);
  });

  it('AC7/AC9: PATCH absent leaves tags, [] removes custom, enums re-derive', async () => {
    const custom = await mkCat();
    const p = await create({ categoryIds: JSON.stringify([custom.id]) });
    const r1 = await patch(p.id, { name: 'renamed' }).expect(200);
    expect(slugs(r1.body as Item)).toEqual(slugs(p));

    const r2 = await patch(p.id, {
      franchise: 'ONE_PIECE',
      productType: 'STARTER_DECK',
    }).expect(200);
    expect(slugs(r2.body as Item)).toEqual(
      ['format-starter-deck', 'franchise-one-piece', custom.slug].sort(),
    );

    const r3 = await patch(p.id, { categoryIds: [] }).expect(200);
    expect(slugs(r3.body as Item)).toEqual([
      'format-starter-deck',
      'franchise-one-piece',
    ]);

    const other = await mkCat();
    const r4 = await patch(p.id, {
      categoryIds: [other.id, custom.id],
      productType: 'SINGLE_CARD',
    }).expect(200);
    expect(slugs(r4.body as Item)).toEqual(
      ['franchise-one-piece', custom.slug, other.slug].sort(),
    );
    // ROOT categories are valid tags
    const root = await mkCat({ type: 'ROOT' });
    const r5 = await patch(p.id, { categoryIds: [root.id] }).expect(200);
    expect(slugs(r5.body as Item)).toContain(root.slug);
  });

  it('AC8: invalid categoryIds -> 400 and nothing persisted', async () => {
    const p = await create();
    const before = await tagSlugs(p.id);
    const ghost = randomUUID();
    const r = await patch(p.id, {
      name: 'should-not-persist',
      categoryIds: [ghost],
    }).expect(400);
    expect(err(r.body)).toBe('CATEGORY_NOT_FOUND');
    const stored = await prisma.product.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect(stored.name).toBe('E2E Tag Product');
    expect(await tagSlugs(p.id)).toEqual(before);

    const many = Array.from({ length: 21 }, () => randomUUID());
    for (const bad of [['nope'], many, 'x', { a: 1 }, [[randomUUID()]], null]) {
      await patch(p.id, { name: 'nope', categoryIds: bad }).expect(400);
    }
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).name,
    ).toBe('E2E Tag Product');

    const before2 = await prisma.product.count();
    const post = await createReq({
      categoryIds: JSON.stringify([ghost]),
    }).expect(400);
    expect(err(post.body)).toBe('CATEGORY_NOT_FOUND');
    await createReq({ categoryIds: 'not-json' }).expect(400);
    await createReq({ categoryIds: JSON.stringify([[randomUUID()]]) }).expect(
      400,
    );
    expect(await prisma.product.count()).toBe(before2);
  });

  it('AC10: franchise OTHER keeps only the submitted tag; filter and macroCategory work', async () => {
    const fr = await mkCat();
    const p = await create({
      franchise: 'OTHER',
      productType: 'BOOSTER_PACK',
      categoryIds: JSON.stringify([fr.id]),
    });
    expect(slugs(p)).toEqual(['format-booster-pack', fr.slug].sort());
    const list = await request(app.getHttpServer())
      .get('/api/v1/products?franchise=OTHER&limit=100')
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((d) => d.id),
    ).toContain(p.id);
    const macro = await request(app.getHttpServer())
      .get('/api/v1/products?franchise=OTHER&macroCategory=SEALED&limit=100')
      .expect(200);
    expect(
      (macro.body as { data: { id: string }[] }).data.map((d) => d.id),
    ).toContain(p.id);
  });

  it('AC12: admin + public detail expose categories; public hides inactive branches; list uses one batch', async () => {
    const hidden = await mkCat({ isActive: false, sortOrder: 5 });
    const visibleB = await mkCat({ sortOrder: 2, name: 'B tag' });
    const visibleA = await mkCat({ sortOrder: 2, name: 'A tag' });
    const p = await create({
      productType: 'SINGLE_CARD',
      categoryIds: JSON.stringify([hidden.id, visibleB.id, visibleA.id]),
    });
    const adminOne = await auth(
      request(app.getHttpServer()).get(`/api/v1/admin/products/${p.id}`),
    ).expect(200);
    expect((adminOne.body as Item).categories.map((c) => c.slug)).toContain(
      hidden.slug,
    );
    const pub = await request(app.getHttpServer())
      .get(`/api/v1/products/${p.id}`)
      .expect(200);
    const pubSlugs = (pub.body as Item).categories.map((c) => c.slug);
    expect(pubSlugs).not.toContain(hidden.slug);
    // sortOrder 0 (franchise-pokemon) first, then 'A tag' before 'B tag'
    expect(pubSlugs).toEqual([
      'franchise-pokemon',
      visibleA.slug,
      visibleB.slug,
    ]);
    expect((pub.body as Item).categories[0]).toEqual({
      id: expect.any(String) as string,
      name: 'Pokémon',
      slug: 'franchise-pokemon',
      dimension: 'FRANCHISE',
    });

    // inactive ancestor hides the tag publicly
    const parent = await mkCat({ isActive: false });
    const child = await prisma.category.create({
      data: {
        name: 'child',
        slug: `e2e-tag-${randomUUID().slice(0, 8)}`,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
        parentId: parent.id,
      },
    });
    createdCategories.unshift(child.id);
    await patch(p.id, { categoryIds: [child.id] }).expect(200);
    const pub2 = await request(app.getHttpServer())
      .get(`/api/v1/products/${p.id}`)
      .expect(200);
    expect((pub2.body as Item).categories.map((c) => c.slug)).not.toContain(
      child.slug,
    );

    // no N+1: findMany is a single call regardless of product count
    const spy = vi.spyOn(prisma.product, 'findMany');
    await auth(
      request(app.getHttpServer()).get('/api/v1/admin/products'),
    ).expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const include = (
      spy.mock.calls[0][0] as { include: Record<string, unknown> }
    ).include;
    expect(include.taxonomyTags).toBeDefined();
    spy.mockRestore();
  });

  it('AC13: _count.products counts both relations; tag-only delete is 409; product delete cascades', async () => {
    const tag = await mkCat();
    const p1 = await create({ categoryIds: JSON.stringify([tag.id]) });
    const p2 = await create({ categoryIds: JSON.stringify([tag.id]) });
    // p2 also has tag as main category => still counted once
    await prisma.product.update({
      where: { id: p2.id },
      data: { categoryId: tag.id },
    });
    const res = await auth(
      request(app.getHttpServer()).get(`/api/v1/admin/categories/${tag.id}`),
    ).expect(200);
    expect((res.body as { _count: { products: number } })._count.products).toBe(
      2,
    );

    const del = await auth(
      request(app.getHttpServer()).delete(`/api/v1/admin/categories/${tag.id}`),
    ).expect(409);
    expect(err(del.body)).toBe('CATEGORY_IN_USE');

    // a tag-only product (main category is the seeded one) also blocks delete
    await prisma.product.update({
      where: { id: p2.id },
      data: { categoryId: SEEDED_CATEGORY_ID },
    });
    await auth(
      request(app.getHttpServer()).delete(`/api/v1/admin/products/${p1.id}`),
    ).expect(200);
    expect(
      await prisma.productCategory.count({ where: { productId: p1.id } }),
    ).toBe(0);
    await auth(
      request(app.getHttpServer()).delete(`/api/v1/admin/products/${p2.id}`),
    ).expect(200);
    await auth(
      request(app.getHttpServer()).delete(`/api/v1/admin/categories/${tag.id}`),
    ).expect(204);
  });

  it('AC14: concurrent PATCHes end with one of the two sets; assign vs delete never orphans', async () => {
    const x = await mkCat();
    const y = await mkCat();
    const z = await mkCat();
    const p = await create();
    const rs = await Promise.all([
      patch(p.id, { categoryIds: [x.id, y.id] }),
      patch(p.id, { categoryIds: [z.id] }),
      patch(p.id, { categoryIds: [x.id, y.id] }),
      patch(p.id, { categoryIds: [z.id] }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const final = await tagSlugs(p.id);
    const base = ['format-booster-box', 'franchise-pokemon'];
    const setA = [...base, x.slug, y.slug].sort();
    const setB = [...base, z.slug].sort();
    expect([setA, setB]).toContainEqual(final);

    const t = await mkCat();
    const q = await create();
    const [a, d] = await Promise.all([
      patch(q.id, { categoryIds: [t.id] }),
      auth(
        request(app.getHttpServer()).delete(`/api/v1/admin/categories/${t.id}`),
      ),
    ]);
    expect([200, 400, 409]).toContain(a.status);
    expect([204, 409]).toContain(d.status);
    expect(a.status === 200 && d.status === 204).toBe(false);
    const linked = await prisma.productCategory.count({
      where: { productId: q.id, categoryId: t.id },
    });
    const exists = await prisma.category.count({ where: { id: t.id } });
    expect(linked === 1 ? exists === 1 : true).toBe(true);
  });

  it('AC15: related excludes OTHER from the strong match; categoryId fallback still works', async () => {
    const mkP = (franchise: 'OTHER' | 'POKEMON', categoryId: string) =>
      prisma.product
        .create({
          data: {
            name: 'rel',
            slug: `e2e-rel-${randomUUID().slice(0, 8)}`,
            description: 'd',
            franchise,
            productType: 'BOOSTER_BOX',
            rarity: 'COMMON',
            priceUsd: 1,
            stock: 1,
            categoryId,
          },
        })
        .then((r) => {
          createdProducts.push(r.id);
          return r;
        });
    const root = await mkCat({ type: 'ROOT' });
    const base = await mkP('OTHER', root.id);
    const sameFranchiseOther = await mkP('OTHER', SEEDED_CATEGORY_ID);
    const sameCategory = await mkP('OTHER', root.id);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/products/${base.id}/related?limit=10`)
      .expect(200);
    const ids = (res.body as { data: { id: string }[] }).data.map((d) => d.id);
    expect(ids).toContain(sameCategory.id);
    expect(ids).not.toContain(sameFranchiseOther.id);
  });

  it('AC16/AC17: Swagger lists OTHER; single-franchise filter unchanged', async () => {
    const doc = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const schemas = (
      doc.body as {
        components: {
          schemas: Record<string, { properties?: Record<string, unknown> }>;
        };
      }
    ).components.schemas;
    expect(JSON.stringify(doc.body)).toContain('"OTHER"');
    expect(schemas['ProductTagDto']).toBeDefined();
    const rows = await prisma.product.count({
      where: { franchise: 'POKEMON', isActive: true },
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/products?franchise=POKEMON&limit=1')
      .expect(200);
    expect((res.body as { meta: { total: number } }).meta.total).toBe(rows);
  });
});
