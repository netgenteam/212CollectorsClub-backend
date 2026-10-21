import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { STANDARD_ROOT_SLUGS } from './../src/admin-catalog/seeded-taxonomy.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';

const ROOT = join(import.meta.dirname, '..');
const MIGRATION_SQL = readFileSync(
  join(
    ROOT,
    'prisma/migrations/20261020100000_epic15_standard_taxonomy/migration.sql',
  ),
  'utf8',
);

/** Splits the migration into executable statements (the DO block is kept whole). */
function statements(sql: string): string[] {
  const doBlocks: string[] = [];
  const withoutDo = sql.replace(/DO \$\$[\s\S]*?END \$\$;/g, (m) => {
    doBlocks.push(m.replace(/;$/, ''));
    return `__DO_${doBlocks.length - 1}__;`;
  });
  return withoutDo
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^__DO_(\d+)__$/.exec(s);
      return m ? doBlocks[Number(m[1])] : s;
    });
}

// Story 15.1 (FR-60..63, AD-51): data migration + importer slug resolution.
describe('Epic 15 standard taxonomy (e2e, Story 15.1)', () => {
  let prisma: PrismaService;
  const tag = `e2e15-${randomUUID().slice(0, 8)}`;
  const ids = {
    emptyRoot: randomUUID(),
    usedRoot: randomUUID(),
    tagUsedRoot: randomUUID(),
    orphanLang: randomUUID(),
    orphanFr: randomUUID(),
    parentedSub: randomUUID(),
    single: randomUUID(),
    pokemonBox: randomUUID(),
    yugioh: randomUUID(),
    topps: randomUUID(),
  };
  let franchisePokemonId: string;
  let franchiseYgoId: string;
  let boosterPackId: string;

  const runMigration = async () => {
    for (const st of statements(MIGRATION_SQL)) {
      await prisma.$executeRawUnsafe(st);
    }
  };
  const snapshot = async () => ({
    categories: await prisma.$queryRawUnsafe(
      `SELECT slug, type::text, dimension::text, "parentId", "isActive" FROM "Categories" ORDER BY slug`,
    ),
    tags: await prisma.$queryRawUnsafe(
      `SELECT "productId", "categoryId" FROM "Product_Categories" ORDER BY 1, 2`,
    ),
  });

  const product = (id: string, slug: string, franchise: string, type: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "Products" (id, name, slug, description, franchise, "productType", rarity, "priceUsd", stock, "categoryId", "updatedAt")
       VALUES ($1::uuid, $2, $3, 'e2e', $4::"Franchise", $5::"ProductType", 'COMMON', 1, 1, $6::uuid, CURRENT_TIMESTAMP)`,
      id,
      slug,
      slug,
      franchise,
      type,
      ids.usedRoot,
    );

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService());
    await prisma.$connect();
    // Make sure the migration is applied once so base rows exist.
    await runMigration();

    const cat = async (
      id: string,
      slug: string,
      type: string,
      dimension: string | null,
      parentId: string | null,
    ) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "Categories" (id, name, slug, type, dimension, "isActive", "sortOrder", "parentId", "updatedAt")
         VALUES ($1::uuid, $2, $2, $3::"CategoryType", $4::"CategoryDimension", true, 0, $5::uuid, CURRENT_TIMESTAMP)`,
        id,
        slug,
        type,
        dimension,
        parentId,
      );
    const rootOf = async (slug: string) =>
      (await prisma.category.findUniqueOrThrow({ where: { slug } })).id;

    await cat(ids.emptyRoot, `${tag}-empty-root`, 'ROOT', null, null);
    await cat(ids.usedRoot, `${tag}-used-root`, 'ROOT', null, null);
    await cat(ids.tagUsedRoot, `${tag}-tag-used-root`, 'ROOT', null, null);
    await cat(
      ids.orphanLang,
      `${tag}-lang`,
      'SUBCATEGORY',
      'EDITION_LANGUAGE',
      null,
    );
    await cat(ids.orphanFr, `${tag}-fr`, 'SUBCATEGORY', 'FRANCHISE', null);
    await cat(
      ids.parentedSub,
      `${tag}-parented`,
      'SUBCATEGORY',
      'FRANCHISE',
      await rootOf('cartas-sueltas'),
    );

    await product(ids.single, `${tag}-single`, 'POKEMON', 'SINGLE_CARD');
    await product(ids.pokemonBox, `${tag}-box`, 'POKEMON', 'BOOSTER_BOX');
    await product(ids.yugioh, `${tag}-ygo`, 'YU_GI_OH', 'SINGLE_CARD');
    await product(ids.topps, `${tag}-topps`, 'TOPPS', 'SINGLE_CARD');

    franchisePokemonId = await rootOf('franchise-pokemon');
    franchiseYgoId = await rootOf('franchise-yu-gi-oh');
    boosterPackId = await rootOf('format-booster-pack');
    // A SINGLE_CARD wrongly tagged with a sealed format; a root only used by a tag.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Product_Categories" ("productId","categoryId") VALUES ($1::uuid,$2::uuid)`,
      ids.single,
      boosterPackId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Product_Categories" ("productId","categoryId") VALUES ($1::uuid,$2::uuid)`,
      ids.pokemonBox,
      boosterPackId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Product_Categories" ("productId","categoryId") VALUES ($1::uuid,$2::uuid)`,
      ids.topps,
      ids.tagUsedRoot,
    );
  });

  afterAll(async () => {
    const productIds = Object.values(ids);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Product_Categories" WHERE "productId" = ANY($1::uuid[])`,
      productIds,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Products" WHERE id = ANY($1::uuid[])`,
      productIds,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Categories" WHERE slug LIKE $1`,
      `${tag}-%`,
    );
    await prisma.$disconnect();
  });

  it('AC1-AC6: migrates roots, parents, cleanup and tags; AC7: second run is a no-op', async () => {
    await runMigration();

    // AC1: roots exist, active, no dimension/parent
    const roots = await prisma.category.findMany({
      where: { slug: { in: [...STANDARD_ROOT_SLUGS] } },
    });
    expect(roots).toHaveLength(3);
    for (const r of roots) {
      expect(r).toMatchObject({
        type: 'ROOT',
        dimension: null,
        parentId: null,
        isActive: true,
      });
    }
    const rootBySlug = new Map(roots.map((r) => [r.slug, r.id]));

    // AC2: orphans parented by dimension; already-parented untouched
    const get = (id: string) =>
      prisma.category.findUniqueOrThrow({ where: { id } });
    expect((await get(ids.orphanFr)).parentId).toBe(
      rootBySlug.get('franquicia-tcg'),
    );
    expect((await get(ids.orphanFr)).dimension).toBe('FRANCHISE');
    expect((await get(ids.orphanLang)).parentId).toBe(
      rootBySlug.get('idioma-edicion'),
    );
    expect((await get(ids.parentedSub)).parentId).not.toBe(
      rootBySlug.get('franquicia-tcg'),
    );
    const sealed = await prisma.category.findMany({
      where: { parentId: rootBySlug.get('formato-sellado') },
    });
    expect(sealed.map((c) => c.slug)).toContain('format-booster-pack');
    const orphansLeft = await prisma.category.count({
      where: {
        type: 'SUBCATEGORY',
        parentId: null,
        dimension: { in: ['FRANCHISE', 'SEALED_FORMAT', 'EDITION_LANGUAGE'] },
      },
    });
    expect(orphansLeft).toBe(0);

    // AC3: protected roots unchanged
    for (const slug of ['cartas-sueltas', 'sobres-y-cajas']) {
      const c = await prisma.category.findUniqueOrThrow({ where: { slug } });
      expect(c).toMatchObject({
        isActive: true,
        parentId: null,
        dimension: null,
      });
    }

    // AC4: unused root deleted; used (Products.categoryId or tag) deactivated
    expect(
      await prisma.category.findUnique({ where: { id: ids.emptyRoot } }),
    ).toBeNull();
    expect((await get(ids.usedRoot)).isActive).toBe(false);
    expect((await get(ids.tagUsedRoot)).isActive).toBe(false);
    expect(
      await prisma.product.count({ where: { categoryId: ids.usedRoot } }),
    ).toBe(4);

    // AC5: no SINGLE_CARD keeps a SEALED_FORMAT tag; sealed keep theirs
    const singlesSealed = await prisma.productCategory.count({
      where: {
        product: { productType: 'SINGLE_CARD' },
        category: { dimension: 'SEALED_FORMAT' },
      },
    });
    expect(singlesSealed).toBe(0);
    expect(
      await prisma.productCategory.count({
        where: {
          productId: ids.pokemonBox,
          category: { dimension: 'SEALED_FORMAT' },
        },
      }),
    ).toBe(1);

    // AC6: franchise tags for supported games; TOPPS untouched
    const tagsOf = async (productId: string) =>
      (await prisma.productCategory.findMany({ where: { productId } })).map(
        (t) => t.categoryId,
      );
    expect(await tagsOf(ids.single)).toContain(franchisePokemonId);
    expect(await tagsOf(ids.yugioh)).toEqual([franchiseYgoId]);
    expect(await tagsOf(ids.topps)).toEqual([ids.tagUsedRoot]);

    // AC7: idempotent
    const first = await snapshot();
    await runMigration();
    expect(await snapshot()).toEqual(first);
  });

  it('AC1/AC2/AC9: public endpoints expose the roots, their children and facet groups', async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    try {
      const rootsRes = await request(app.getHttpServer())
        .get('/api/v1/categories?type=ROOT')
        .expect(200);
      const list = (
        Array.isArray(rootsRes.body)
          ? rootsRes.body
          : (rootsRes.body as { data: unknown }).data
      ) as { id: string; slug: string }[];
      for (const slug of STANDARD_ROOT_SLUGS) {
        expect(list.map((c) => c.slug)).toContain(slug);
      }
      const fr = list.find((c) => c.slug === 'franquicia-tcg')!;
      const kidsRes = await request(app.getHttpServer())
        .get(`/api/v1/categories?parentId=${fr.id}`)
        .expect(200);
      const kids = (
        Array.isArray(kidsRes.body)
          ? kidsRes.body
          : (kidsRes.body as { data: unknown }).data
      ) as { slug: string }[];
      expect(kids.map((c) => c.slug)).toContain('franchise-pokemon');

      const facets = await request(app.getHttpServer())
        .get('/api/v1/catalog/facets')
        .expect(200);
      const groups = (
        facets.body as {
          categoryGroups: { slug: string; children: { slug: string }[] }[];
          franchises: unknown[];
          formats: unknown[];
          languages: unknown[];
          totals: unknown;
        }
      ).categoryGroups;
      const g = groups.find((x) => x.slug === 'franquicia-tcg');
      expect(g?.children.map((c) => c.slug)).toContain('franchise-pokemon');
      expect(groups.map((x) => x.slug)).toContain('formato-sellado');
      expect(facets.body).toHaveProperty('totals');
      expect(facets.body).toHaveProperty('franchises');
    } finally {
      await app.close();
    }
  });

  describe('AC10: import-tcgapi.mjs --dry-run resolves categories by slug', () => {
    const run = (extra: Record<string, string>) => {
      const env = {
        PATH: process.env.PATH ?? '',
        API_BASE_URL: 'http://api.test/api/v1',
        ADMIN_USER: 'x',
        ADMIN_PASSWORD: 'x',
        TCGAPI_KEY: 'fake-key',
        TCG_GAME: 'pokemon',
        ...extra,
      };
      const res = execFileSync(
        process.execPath,
        [
          '--import',
          join(import.meta.dirname, 'fixtures/mock-fetch-importer.mjs'),
          join(ROOT, 'scripts/import-tcgapi.mjs'),
          '--dry-run',
        ],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return res;
    };

    it('single: cartas-sueltas root + only the franchise tag', () => {
      const out = run({});
      expect(out).toContain("categoryId: 'id-cartas-sueltas'");
      expect(out).toContain('["id-franchise-pokemon"]');
      expect(out).not.toContain('format-');
    });

    it('sealed: sobres-y-cajas root, still no format tag sent', () => {
      const out = run({ TCG_TYPE: 'Sealed Products' });
      expect(out).toContain("categoryId: 'id-sobres-y-cajas'");
      expect(out).toContain('["id-franchise-pokemon"]');
    });

    it('CATEGORY_ID still overrides', () => {
      const out = run({ CATEGORY_ID: 'override-id' });
      expect(out).toContain("categoryId: 'override-id'");
    });
  });
});
