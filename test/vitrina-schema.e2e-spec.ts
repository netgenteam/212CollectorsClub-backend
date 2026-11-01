import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { PrismaModule } from './../src/prisma/prisma.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

/**
 * Story 18.6 (AD-81, AC1-2): Vitrina scoring schema applied by the migration.
 * Own rows only (token below); the real `Vitrina_Algorithm_Settings` row is
 * snapshotted and restored byte for byte.
 */
describe('Vitrina scoring schema (e2e, Story 18.6)', () => {
  let prisma: PrismaService;
  const token = 'e2e-vitrina-186';
  let productId: string;
  let savedSetting: Record<string, unknown>[];

  const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(sql, ...p);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();
    prisma = mod.get(PrismaService);
    await mod.init();
    savedSetting = await rows(
      `SELECT * FROM "Vitrina_Algorithm_Settings" WHERE id = 'default'`,
    );
    // leftovers of an aborted run (own slugs only)
    await prisma.product.deleteMany({
      where: { slug: { startsWith: token } },
    });
    const category = await prisma.category.findFirstOrThrow();
    const p = await prisma.product.create({
      data: {
        name: token,
        slug: token,
        description: 'Created by e2e 18.6.',
        franchise: 'POKEMON',
        productType: 'BOOSTER_PACK',
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock: 5,
        categoryId: category.id,
      },
    });
    productId = p.id;
  });

  afterAll(async () => {
    // own rows: scores/runs/stats first, then the product
    await prisma.productScoreRun.deleteMany({
      where: { config: { path: ['token'], equals: token } },
    });
    if (productId) {
      await prisma.productDailyStat.deleteMany({ where: { productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    await prisma.product.deleteMany({ where: { slug: { startsWith: token } } });
    // restore the real singleton byte for byte (raw: keeps `updatedAt`)
    const [s] = savedSetting;
    if (s) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Vitrina_Algorithm_Settings" (id, "updatedAt") VALUES ('default', now()) ON CONFLICT (id) DO NOTHING`,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "Vitrina_Algorithm_Settings" SET "wSales"=$1,"wRevenue"=$2,"wVelocity"=$3,"wInterest"=$4,"wNovelty"=$5,
         "halfLifeDays"=$6,"windowDays"=$7,"noveltyDays"=$8,"maxPerFranchise"=$9,"mmrLambda"=$10,"priorM"=$11,
         "scarcityThreshold"=$12,"minSalesForRanking"=$13,"viewDayCap"=$14,"currentRunId"=$15,"updatedAt"=$16,"updatedById"=$17
         WHERE id='default'`,
        s.wSales,
        s.wRevenue,
        s.wVelocity,
        s.wInterest,
        s.wNovelty,
        s.halfLifeDays,
        s.windowDays,
        s.noveltyDays,
        s.maxPerFranchise,
        s.mmrLambda,
        s.priorM,
        s.scarcityThreshold,
        s.minSalesForRanking,
        s.viewDayCap,
        s.currentRunId,
        s.updatedAt,
        s.updatedById,
      );
    }
    await prisma.$disconnect();
  });

  it('seeds the singleton with the A63 defaults', async () => {
    const [s] = await rows<Record<string, unknown>>(
      `SELECT * FROM "Vitrina_Algorithm_Settings" WHERE id = 'default'`,
    );
    expect(s).toBeDefined();
    const weights = [
      s.wSales,
      s.wRevenue,
      s.wVelocity,
      s.wInterest,
      s.wNovelty,
    ];
    expect(weights.reduce((a, b) => (a as number) + (b as number), 0)).toBe(
      100,
    );
    expect(s.maxPerFranchise).toBe(4);
    expect(s.minSalesForRanking).toBe(5);
    expect(s.viewDayCap).toBe(30);
  });

  it('the migration seed is idempotent and never overwrites edits', async () => {
    const sql = readFileSync(
      new URL(
        './../prisma/migrations/20261101200000_add_vitrina_scoring/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const insert = sql.slice(
      sql.lastIndexOf('INSERT INTO "Vitrina_Algorithm_Settings"'),
    );
    expect(insert).toMatch(/ON CONFLICT \("id"\) DO NOTHING/);
    await prisma.$executeRawUnsafe(
      `UPDATE "Vitrina_Algorithm_Settings" SET "halfLifeDays" = 21 WHERE id='default'`,
    );
    await prisma.$executeRawUnsafe(insert);
    await prisma.$executeRawUnsafe(insert);
    const [{ n }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Vitrina_Algorithm_Settings"`,
    );
    expect(n).toBe(1);
    const [s] = await rows<{ halfLifeDays: number }>(
      `SELECT "halfLifeDays" FROM "Vitrina_Algorithm_Settings" WHERE id='default'`,
    );
    expect(s.halfLifeDays).toBe(21);
  });

  it('CHECK rejects weights that do not sum to 100 or are negative', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Vitrina_Algorithm_Settings" SET "wSales" = 41 WHERE id='default'`,
      ),
    ).rejects.toThrow(/weights_sum_check/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Vitrina_Algorithm_Settings" (id, "updatedAt", "wSales","wRevenue","wVelocity","wInterest","wNovelty")
         VALUES ('${token}', now(), 110, 0, 0, 0, -10)`,
      ),
    ).rejects.toThrow(/weights_sum_check/);
    // a valid redistribution is accepted
    await prisma.$executeRawUnsafe(
      `UPDATE "Vitrina_Algorithm_Settings" SET "wSales"=50,"wRevenue"=5 WHERE id='default'`,
    );
  });

  it('Product_Daily_Stats: composite PK, no personal columns, day index', async () => {
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='Product_Daily_Stats'`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      ['cartAdds', 'day', 'productId', 'views'].sort(),
    );
    const day = new Date('2026-10-31T00:00:00Z');
    await prisma.productDailyStat.create({
      data: { productId, day, views: 3, cartAdds: 1 },
    });
    await expect(
      prisma.productDailyStat.create({ data: { productId, day } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const idx = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='Product_Daily_Stats'`,
    );
    expect(idx.map((i) => i.indexname)).toContain(
      'Product_Daily_Stats_day_idx',
    );
  });

  it('runs/scores: PK (runId, productId), mode enum, cascade from run and product', async () => {
    const run = await prisma.productScoreRun.create({
      data: {
        mode: 'RANKED',
        config: { token },
        salesCount: 7,
        durationMs: 12,
        scores: {
          create: {
            productId,
            rank: 1,
            score: '42.12345',
            components: { score: 42.12345 },
            reason: 'NEW',
          },
        },
      },
      include: { scores: true },
    });
    expect(run.scores[0].score.toString()).toBe('42.1235');
    await expect(
      prisma.productScore.create({
        data: { runId: run.id, productId, rank: 2, score: 1, components: {} },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Product_Score_Runs" (id, mode, config, "salesCount", "durationMs") VALUES (gen_random_uuid(), 'BOGUS', '{}', 0, 0)`,
      ),
    ).rejects.toThrow();
    const idx = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='Product_Scores'`,
    );
    expect(idx.map((i) => i.indexname)).toContain(
      'Product_Scores_runId_rank_idx',
    );
    await prisma.productScoreRun.delete({ where: { id: run.id } });
    expect(await prisma.productScore.count({ where: { runId: run.id } })).toBe(
      0,
    );
  });

  it('deleting a product cascades its stats and scores', async () => {
    const p2 = await prisma.product.create({
      data: {
        name: `${token}-2`,
        slug: `${token}-2`,
        description: 'x',
        franchise: 'POKEMON',
        productType: 'BOOSTER_PACK',
        rarity: 'COMMON',
        priceUsd: '1.00',
        stock: 1,
        categoryId: (await prisma.category.findFirstOrThrow()).id,
      },
    });
    const run = await prisma.productScoreRun.create({
      data: {
        mode: 'FALLBACK',
        config: { token },
        salesCount: 0,
        durationMs: 1,
        scores: {
          create: { productId: p2.id, rank: 1, score: 0, components: {} },
        },
      },
    });
    await prisma.productDailyStat.create({
      data: { productId: p2.id, day: new Date('2026-10-30T00:00:00Z') },
    });
    await prisma.product.delete({ where: { id: p2.id } });
    expect(await prisma.productScore.count({ where: { runId: run.id } })).toBe(
      0,
    );
    expect(
      await prisma.productDailyStat.count({ where: { productId: p2.id } }),
    ).toBe(0);
  });

  it('NFR-18.3 indexes exist exactly once', async () => {
    const names = [
      'Order_Lines_productId_createdAt_idx',
      'Orders_status_createdAt_idx',
      'Wishlist_Items_productId_createdAt_idx',
    ];
    const found = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      names,
    );
    expect(found.map((f) => f.indexname).sort()).toEqual([...names].sort());
  });
});
