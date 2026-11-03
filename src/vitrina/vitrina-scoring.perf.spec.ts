import { describe, expect, it } from 'vitest';
import { computeRanking, VITRINA_MMR_K } from './vitrina-scoring.js';
import type {
  ScoringConfig,
  ScoringEvents,
  ScoringProduct,
} from './vitrina.types.js';

const NOW = new Date('2026-11-01T00:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

const CFG: ScoringConfig = {
  wSales: 40,
  wRevenue: 15,
  wVelocity: 15,
  wInterest: 20,
  wNovelty: 10,
  halfLifeDays: 14,
  windowDays: 90,
  noveltyDays: 21,
  maxPerFranchise: 4,
  mmrLambda: 0.35,
  priorM: 3,
  scarcityThreshold: 3,
  minSalesForRanking: 5,
  viewDayCap: 30,
};

const OLD = ago(365);
const prod = (id: string, o: Partial<ScoringProduct> = {}): ScoringProduct => ({
  id,
  createdAt: OLD,
  franchiseKey: `F-${id}`,
  productType: `T-${id}`,
  availableStock: 10,
  ...o,
});
const noEvents = (): ScoringEvents => ({
  sales: [],
  wishlist: [],
  cartAdds: [],
  views: [],
});
const run = (products: ScoringProduct[], events: Partial<ScoringEvents> = {}) =>
  computeRanking({
    products,
    events: { ...noEvents(), ...events },
    config: { ...CFG },
    now: NOW,
  });
const sale = (productId: string, qty: number, days: number, lineTotal = 0) => ({
  productId,
  qty,
  lineTotal,
  at: ago(days),
});

/**
 * Story 19.3b: the time budget of NFR-18.3, moved out of
 * `vitrina-scoring.spec.ts` (its functional twin stays there). `pnpm test:perf`.
 */
describe('performance (NFR-18.3)', () => {
  it('10 000 products with synthetic events in < 5 s, no I/O', () => {
    let seed = 1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const products = Array.from({ length: 10_000 }, (_, i) =>
      prod(`p${String(i).padStart(5, '0')}`, {
        createdAt: ago(rnd() * 400),
        franchiseKey: `F${i % 40}`,
        productType: `T${i % 7}`,
        availableStock: Math.floor(rnd() * 10),
      }),
    );
    const events = noEvents();
    for (let i = 0; i < 40_000; i++) {
      const p = products[Math.floor(rnd() * products.length)].id;
      events.sales.push(sale(p, 1 + Math.floor(rnd() * 3), rnd() * 100, 9.9));
      if (i % 2) events.wishlist.push({ productId: p, at: ago(rnd() * 100) });
      if (i % 3)
        events.cartAdds.push({
          productId: p,
          day: ago(Math.floor(rnd() * 90)),
          n: 2,
        });
      if (i % 2)
        events.views.push({
          productId: p,
          day: ago(Math.floor(rnd() * 90)),
          n: 12,
        });
    }
    const t0 = process.hrtime.bigint();
    const r = run(products, events);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(5000);
    expect(r.mode).toBe('RANKED');
    expect(r.ranked).toHaveLength(VITRINA_MMR_K);
    const counts = new Map<string, number>();
    const fk = new Map(products.map((p) => [p.id, p.franchiseKey]));
    for (const x of r.ranked)
      counts.set(fk.get(x.id)!, (counts.get(fk.get(x.id)!) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4);
  });
});
