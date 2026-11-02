import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { VitrinaScoringService } from './../src/vitrina/vitrina-scoring.service.js';
import {
  restoreDailyStats,
  snapshotDailyStats,
  type DailyStatRows,
} from './helpers/db-snapshot.js';
import {
  restoreVitrina,
  snapshotVitrina,
  type VitrinaSnapshot,
} from './helpers/vitrina-snapshot.js';

const TAG = randomUUID().slice(0, 8);
const PRODUCTS = 10_000;
const LINES = 30_000;
/** `VITRINA_PERF_SKIP=1` skips this heavy test on slow machines. */
const maybe = process.env.VITRINA_PERF_SKIP === '1' ? describe.skip : describe;

/** Wraps a Prisma tx client counting every query-issuing call. */
function countingTx<T extends object>(tx: T, counter: { n: number }): T {
  const wrap = (target: object, depth: number): object =>
    new Proxy(target, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv) as unknown;
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            if (
              depth >= 1 ||
              String(prop).startsWith('$query') ||
              String(prop) === '$executeRaw'
            )
              counter.n++;
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (
          v &&
          typeof v === 'object' &&
          depth === 0 &&
          !String(prop).startsWith('$')
        ) {
          return wrap(v, 1);
        }
        return v;
      },
    });
  return wrap(tx, 0) as T;
}

/**
 * Story 18.8 AC8 (NFR-18.2/18.3): recompute over 10 000 synthetic products
 * and 30 000 order lines in < 5 s with a bounded number of statements.
 */
maybe('Vitrina recompute performance (e2e, Story 18.8)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let scoring: VitrinaScoringService;
  let saved: VitrinaSnapshot;
  let savedStats: DailyStatRows;
  const orderIds: string[] = [];
  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    scoring = moduleRef.get(VitrinaScoringService);
    saved = await snapshotVitrina(sql);
    savedStats = await snapshotDailyStats(prisma);
    const categoryId = (await prisma.category.findFirstOrThrow()).id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Products" ("id","name","slug","description","franchise","productType","rarity",
         "priceUsd","stock","heldQty","isActive","categoryId","createdAt","updatedAt")
       SELECT gen_random_uuid(), 'Perf ${TAG} ' || g, 'perf-${TAG}-' || g, 'perf',
         (ARRAY['POKEMON','NARUTO','ONE_PIECE','YU_GI_OH','MAGIC_THE_GATHERING'])[1 + g % 5]::"Franchise",
         'BOOSTER_BOX'::"ProductType", 'COMMON'::"Rarity", 5, 10 + g % 40, 0, true, $1::uuid,
         now() - (g % 120 || ' days')::interval, now()
       FROM generate_series(1, ${PRODUCTS}) g`,
      categoryId,
    );
    const created = await prisma.order.createManyAndReturn({
      data: Array.from({ length: 50 }, () => ({
        status: 'PAID' as const,
        paymentRail: 'PAGO_MOVIL' as const,
        fulfillmentType: 'PICKUP' as const,
        recipientName: 'Perf',
        recipientPhone: '0412',
        totalUsd: '1.00',
        accessTokenHash: createHash('sha256')
          .update(randomBytes(16))
          .digest('hex'),
      })),
      select: { id: true },
    });
    orderIds.push(...created.map((o) => o.id));
    await prisma.$executeRawUnsafe(
      `WITH p AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM "Products" WHERE slug LIKE 'perf-${TAG}-%'),
            o AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM "Orders" WHERE id = ANY($1::uuid[]))
       INSERT INTO "Order_Lines" ("id","orderId","productId","productName","unitPriceUsd","quantity","lineTotalUsd","createdAt")
       SELECT gen_random_uuid(), o.id, p.id, 'x', 5, 1 + g % 3, 5 * (1 + g % 3),
              now() - (random() * 80 || ' days')::interval
       FROM generate_series(1, ${LINES}) g
       JOIN p ON p.rn = 1 + (g * 7) % ${PRODUCTS}
       JOIN o ON o.rn = 1 + g % 50`,
      orderIds,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Product_Daily_Stats" ("productId","day","views","cartAdds")
       SELECT id, current_date, 3, 1 FROM "Products" WHERE slug LIKE 'perf-${TAG}-%'`,
    );
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    // scores/stats -> orders -> products
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Product_Scores" WHERE "productId" IN (SELECT id FROM "Products" WHERE slug LIKE 'perf-${TAG}-%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Product_Daily_Stats" WHERE "productId" IN (SELECT id FROM "Products" WHERE slug LIKE 'perf-${TAG}-%')`,
    );
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `perf-${TAG}-` } },
    });
    await restoreDailyStats(prisma, savedStats);
    await restoreVitrina(sql, saved);
    expect(JSON.stringify(await snapshotVitrina(sql))).toBe(
      JSON.stringify(saved),
    );
    await moduleRef.close();
  }, 120_000);

  it(`recompute over ${PRODUCTS} products < 5 s with a bounded statement count`, async () => {
    const counter = { n: 0 };
    const orig = prisma.$transaction.bind(prisma) as unknown as (
      fn: (tx: never) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;
    vi.spyOn(prisma, '$transaction').mockImplementation(
      (fn: (tx: never) => Promise<unknown>, o?: unknown) =>
        orig((tx: never) => fn(countingTx(tx as object, counter) as never), o),
    );
    const t0 = Date.now();
    const r = await scoring.recompute('ADMIN');
    const ms = Date.now() - t0;
    vi.restoreAllMocks();
    if (r.status !== 'OK') throw new Error('busy');
    expect(ms).toBeLessThan(5000);
    // lock + settings(2) + 4 loader reads + run + scores + pointer + prune: independent of N.
    expect(counter.n).toBeLessThanOrEqual(14);
    expect(counter.n).toBeGreaterThanOrEqual(8);
    const rows = await sql(
      `SELECT count(*)::int n FROM "Product_Scores" WHERE "runId" = $1::uuid`,
      [r.runId],
    );
    // 5 synthetic franchises x maxPerFranchise 4 (+ real products) are all that fits.
    expect(rows[0].n as number).toBeGreaterThanOrEqual(20);
    expect(rows[0].n as number).toBeLessThanOrEqual(48);
    expect(r.mode).toBe('RANKED');
  }, 60_000);
});
