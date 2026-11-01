import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeRanking, VITRINA_MMR_K } from './vitrina-scoring.js';
import type {
  ScoringConfig,
  ScoringEvents,
  ScoringInput,
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
const run = (
  products: ScoringProduct[],
  events: Partial<ScoringEvents> = {},
  config: Partial<ScoringConfig> = {},
) =>
  computeRanking({
    products,
    events: { ...noEvents(), ...events },
    config: { ...CFG, ...config },
    now: NOW,
  });
const sale = (productId: string, qty: number, days: number, lineTotal = 0) => ({
  productId,
  qty,
  lineTotal,
  at: ago(days),
});
const byId = (r: ReturnType<typeof run>, id: string) =>
  r.ranked.find((x) => x.id === id)!;
const ids = (r: ReturnType<typeof run>) => r.ranked.map((x) => x.id);
/** Only novelty counts: score = 100 * N * scarcity, N controlled by age. */
const NOVELTY_ONLY: Partial<ScoringConfig> = {
  wSales: 0,
  wRevenue: 0,
  wVelocity: 0,
  wInterest: 0,
  wNovelty: 100,
  noveltyDays: 100,
  minSalesForRanking: 0,
};

describe('purity', () => {
  it('source has no Prisma, Nest, clock or randomness', () => {
    const src = readFileSync(
      new URL('./vitrina-scoring.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(
      /Date\.now|new Date\(\)|Math\.random|performance\./,
    );
    expect(src).not.toMatch(/^import .*(prisma|@nestjs)/im);
  });

  it('does not mutate its input', () => {
    const input: ScoringInput = {
      products: [prod('a'), prod('b')],
      events: { ...noEvents(), sales: [sale('a', 2, 3, 10)] },
      config: { ...CFG },
      now: NOW,
    };
    const before = JSON.stringify(input);
    computeRanking(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('time decay (half-life)', () => {
  it('a sale exactly H days old weighs 0.5; 2H old 0.25; today 1', () => {
    const r = run([prod('a'), prod('b'), prod('c')], {
      sales: [sale('a', 1, 14, 10), sale('b', 1, 28), sale('c', 1, 0)],
    });
    expect(byId(r, 'a').components.sales.raw).toBe(0.5);
    expect(byId(r, 'a').components.revenue.raw).toBe(5);
    expect(byId(r, 'b').components.sales.raw).toBe(0.25);
    expect(byId(r, 'c').components.sales.raw).toBe(1);
  });

  it('qty multiplies: 3 units at H days = 1.5', () => {
    const r = run([prod('a')], { sales: [sale('a', 3, 14)] });
    expect(byId(r, 'a').components.sales.raw).toBe(1.5);
  });

  it('events older than windowDays are ignored; exactly windowDays counts', () => {
    const r = run(
      [prod('in'), prod('out')],
      { sales: [sale('in', 1, 90), sale('out', 1, 90.01)] },
      { halfLifeDays: 90 },
    );
    expect(byId(r, 'in').components.sales.raw).toBe(0.5);
    expect(byId(r, 'out').components.sales.raw).toBe(0);
    expect(r.salesCount).toBe(1);
  });

  it('future events (after now) are ignored', () => {
    const r = run([prod('a')], { sales: [sale('a', 1, -1)] });
    expect(byId(r, 'a').components.sales.raw).toBe(0);
    expect(r.salesCount).toBe(0);
  });

  it('smaller windowDays shrinks what counts', () => {
    const r = run(
      [prod('a')],
      { sales: [sale('a', 1, 20)] },
      { windowDays: 10 },
    );
    expect(byId(r, 'a').components.sales.raw).toBe(0);
  });
});

describe('percentile normalisation', () => {
  it('distinct values: z = (rank - 0.5) / N among products with x > 0', () => {
    const r = run([prod('a'), prod('b'), prod('c')], {
      sales: [sale('a', 1, 0), sale('b', 2, 0), sale('c', 3, 0)],
    });
    expect(byId(r, 'a').components.sales.z).toBeCloseTo(1 / 6, 12);
    expect(byId(r, 'b').components.sales.z).toBeCloseTo(0.5, 12);
    expect(byId(r, 'c').components.sales.z).toBeCloseTo(5 / 6, 12);
  });

  it('ties get the mid-rank: [1,1,3] -> z = 1/3, 1/3, 5/6', () => {
    const r = run([prod('a'), prod('b'), prod('c')], {
      sales: [sale('a', 1, 0), sale('b', 1, 0), sale('c', 3, 0)],
    });
    expect(byId(r, 'a').components.sales.z).toBeCloseTo(1 / 3, 12);
    expect(byId(r, 'b').components.sales.z).toBeCloseTo(1 / 3, 12);
    expect(byId(r, 'c').components.sales.z).toBeCloseTo(5 / 6, 12);
  });

  it('all tied -> z = 0.5; single product -> z = 0.5', () => {
    const r = run([prod('a'), prod('b')], {
      sales: [sale('a', 2, 0), sale('b', 2, 0)],
    });
    expect(byId(r, 'a').components.sales.z).toBeCloseTo(0.5, 12);
    expect(byId(r, 'b').components.sales.z).toBeCloseTo(0.5, 12);
    const s = run([prod('a')], { sales: [sale('a', 7, 0)] });
    expect(byId(s, 'a').components.sales.z).toBe(0.5);
  });

  it('signal 0 -> z = 0 and zSmoothed = 0, and is not counted in N', () => {
    const r = run([prod('a'), prod('b'), prod('zero')], {
      sales: [sale('a', 1, 0), sale('b', 2, 0)],
    });
    const z = byId(r, 'zero').components.sales;
    expect(z.z).toBe(0);
    expect(z.zSmoothed).toBe(0);
    // N = 2 (not 3): z(a) = 0.25
    expect(byId(r, 'a').components.sales.z).toBeCloseTo(0.25, 12);
  });

  it('an outlier best-seller does not flatten the rest (no min-max)', () => {
    const r = run([prod('a'), prod('b'), prod('whale')], {
      sales: [sale('a', 1, 0), sale('b', 2, 0), sale('whale', 100000, 0)],
    });
    expect(byId(r, 'b').components.sales.z).toBeCloseTo(0.5, 12);
  });

  it('floating-point noise (3 x d vs d+d+d) does not break a tie', () => {
    const r = run([prod('a'), prod('b')], {
      sales: [
        sale('a', 3, 5),
        sale('b', 1, 5),
        sale('b', 1, 5),
        sale('b', 1, 5),
      ],
    });
    expect(byId(r, 'a').components.sales.z).toBe(
      byId(r, 'b').components.sales.z,
    );
  });
});

describe('Bayesian smoothing', () => {
  it("z' = (n*z + m*C)/(n+m) with hand-computed values", () => {
    // N=2: zA = 0.25, zB = 0.75, C = 0.5, m = 3.
    const r = run([prod('a'), prod('b')], {
      sales: [sale('a', 1, 0), sale('b', 20, 0)],
    });
    expect(byId(r, 'a').components.sales.zSmoothed).toBeCloseTo(
      (1 * 0.25 + 3 * 0.5) / 4,
      12,
    );
    expect(byId(r, 'b').components.sales.zSmoothed).toBeCloseTo(
      (20 * 0.75 + 3 * 0.5) / 23,
      12,
    );
  });

  it('1 sale scores below 20 sales', () => {
    const r = run([prod('one'), prod('twenty')], {
      sales: [sale('one', 1, 0, 5), sale('twenty', 20, 0, 100)],
    });
    expect(byId(r, 'one').score).toBeLessThan(byId(r, 'twenty').score);
    expect(ids(r)[0]).toBe('twenty');
  });

  it("priorM = 0 disables shrinkage (z' = z)", () => {
    const r = run(
      [prod('a'), prod('b')],
      { sales: [sale('a', 1, 0), sale('b', 20, 0)] },
      { priorM: 0 },
    );
    expect(byId(r, 'a').components.sales.zSmoothed).toBeCloseTo(0.25, 12);
  });
});

describe('interest and velocity raw signals', () => {
  it('I = 3*wishlist + 2*cartAdds + views (capped per day), decayed', () => {
    const r = run([prod('a')], {
      wishlist: [{ productId: 'a', at: ago(0) }],
      cartAdds: [{ productId: 'a', day: ago(0), n: 2 }],
      views: [{ productId: 'a', day: ago(0), n: 50 }],
    });
    expect(byId(r, 'a').components.interest.raw).toBe(3 + 4 + 30);
  });

  it('interest events decay with the same half-life', () => {
    const r = run([prod('a')], {
      wishlist: [{ productId: 'a', at: ago(14) }],
      cartAdds: [{ productId: 'a', day: ago(14), n: 2 }],
    });
    expect(byId(r, 'a').components.interest.raw).toBe(1.5 + 2);
  });

  it('views are capped per day, not per product', () => {
    const r = run(
      [prod('a')],
      {
        views: [
          { productId: 'a', day: ago(0), n: 100 },
          { productId: 'a', day: ago(14), n: 20 },
        ],
      },
      { viewDayCap: 30 },
    );
    expect(byId(r, 'a').components.interest.raw).toBe(30 + 10);
  });

  it('velocity: u7=3 (age 2), u7p=1 (age 10), m=3 -> ln(1.5)*ln(4)', () => {
    const r = run([prod('a')], { sales: [sale('a', 3, 2), sale('a', 1, 10)] });
    expect(byId(r, 'a').components.velocity.raw).toBeCloseTo(
      Math.log(1.5) * Math.log(4),
      8,
    );
  });

  it('velocity is 0 when the trend is falling or flat or nothing recent', () => {
    const r = run([prod('fall'), prod('flat'), prod('old')], {
      sales: [
        sale('fall', 1, 2),
        sale('fall', 5, 10),
        sale('flat', 2, 3),
        sale('flat', 2, 9),
        sale('old', 9, 30),
      ],
    });
    expect(byId(r, 'fall').components.velocity.raw).toBe(0);
    expect(byId(r, 'flat').components.velocity.raw).toBe(0);
    expect(byId(r, 'old').components.velocity.raw).toBe(0);
  });

  it('velocity week boundaries: age 6.99 is u7, 7 is u7p, 14 is out', () => {
    const r = run([prod('a')], {
      sales: [sale('a', 1, 6.99), sale('a', 1, 7), sale('a', 1, 14)],
    });
    // u7 = 1, u7p = 1, m = 3 -> r = 1 -> V = 0
    expect(byId(r, 'a').components.velocity.raw).toBe(0);
    const r2 = run([prod('a')], { sales: [sale('a', 4, 6.99)] });
    expect(byId(r2, 'a').components.velocity.raw).toBeCloseTo(
      Math.log(7 / 3) * Math.log(5),
      8,
    );
  });

  it('priorM = 0 with no previous-week units does not divide by zero', () => {
    const r = run([prod('a')], { sales: [sale('a', 3, 1)] }, { priorM: 0 });
    const v = byId(r, 'a').components.velocity.raw;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(Math.log(4) * Math.log(4), 8);
  });
});

describe('novelty and scarcity (hand-computed scores)', () => {
  it('novelty = 1 - age/noveltyDays, 10 points at weight 10', () => {
    const r = run([prod('new', { createdAt: ago(10.5) })], {});
    const c = byId(r, 'new').components;
    expect(c.novelty.raw).toBeCloseTo(0.5, 12);
    expect(c.novelty.points).toBeCloseTo(5, 12);
    expect(byId(r, 'new').score).toBeCloseTo(5, 12);
  });

  it('novelty is 0 at/after noveltyDays and when noveltyDays = 0', () => {
    expect(
      byId(run([prod('a', { createdAt: ago(21) })]), 'a').components.novelty
        .raw,
    ).toBe(0);
    expect(
      byId(run([prod('a', { createdAt: ago(40) })]), 'a').components.novelty
        .raw,
    ).toBe(0);
    expect(
      byId(run([prod('a', { createdAt: ago(0) })], {}, { noveltyDays: 0 }), 'a')
        .components.novelty.raw,
    ).toBe(0);
  });

  it('a createdAt in the future is treated as brand new (N = 1)', () => {
    const r = run([prod('a', { createdAt: ago(-3) })]);
    expect(byId(r, 'a').components.novelty.raw).toBe(1);
  });

  it('scarcity factor: avail 1,2,3 -> 0.7, 0.8, 0.9; avail > T -> 1', () => {
    const mk = (id: string, stock: number) =>
      prod(id, { createdAt: ago(0), availableStock: stock });
    const r = run([mk('s1', 1), mk('s2', 2), mk('s3', 3), mk('s4', 4)]);
    expect(byId(r, 's1').components.scarcityFactor).toBeCloseTo(0.7, 12);
    expect(byId(r, 's2').components.scarcityFactor).toBeCloseTo(0.8, 12);
    expect(byId(r, 's3').components.scarcityFactor).toBeCloseTo(0.9, 12);
    expect(byId(r, 's4').components.scarcityFactor).toBe(1);
    // novelty-only base = 10 -> scores 7, 8, 9, 10
    expect(byId(r, 's1').score).toBeCloseTo(7, 12);
    expect(byId(r, 's2').score).toBeCloseTo(8, 12);
    expect(byId(r, 's3').score).toBeCloseTo(9, 12);
    expect(byId(r, 's4').score).toBeCloseTo(10, 12);
  });

  it('scarcity penalises but never excludes (stock 1 still listed)', () => {
    const r = run([prod('a', { availableStock: 1 })]);
    expect(ids(r)).toEqual(['a']);
  });
});

describe('exclusions', () => {
  it('drops inactive, avail <= 0, fractional < 1, NaN and negative stock', () => {
    const r = run([
      prod('ok'),
      prod('inactive', { isActive: false }),
      prod('zero', { availableStock: 0 }),
      prod('neg', { availableStock: -2 }),
      prod('nan', { availableStock: NaN }),
      prod('inf', { availableStock: Infinity }),
      prod('half', { availableStock: 0.5 }),
    ]);
    expect(ids(r)).toEqual(['ok']);
  });

  it('excluded products do not influence the percentile of the others', () => {
    const r = run([prod('a'), prod('b'), prod('gone', { availableStock: 0 })], {
      sales: [sale('a', 1, 0), sale('b', 2, 0), sale('gone', 99, 0)],
    });
    expect(byId(r, 'a').components.sales.z).toBeCloseTo(0.25, 12);
  });

  it('events for unknown products are ignored', () => {
    const r = run([prod('a')], { sales: [sale('ghost', 50, 0)] });
    expect(r.salesCount).toBe(0);
  });
});

describe('PRD case', () => {
  const products = [
    prod('A'),
    prod('B'),
    prod('C', { createdAt: ago(2) }),
    ...['d1', 'd2', 'd3', 'd4'].map((id) => prod(id)),
  ];
  const events = {
    sales: [
      sale('A', 30, 60, 300),
      sale('B', 8, 5, 80),
      sale('C', 2, 1, 20),
      sale('d1', 1, 40, 10),
      sale('d2', 1, 40, 10),
    ],
  };
  const r = run(products, events);

  it('B (8 sales 5d ago) outranks A (30 sales 60d ago)', () => {
    expect(r.mode).toBe('RANKED');
    const rankA = byId(r, 'A').rank;
    expect(byId(r, 'B').rank).toBeLessThan(rankA);
    // hand check of the raw signals
    expect(byId(r, 'A').components.sales.raw).toBeCloseTo(
      30 * Math.pow(0.5, 60 / 14),
      8,
    );
    expect(byId(r, 'B').components.sales.raw).toBeCloseTo(
      8 * Math.pow(0.5, 5 / 14),
      8,
    );
  });

  it('new C with 2 sales appears, and above A', () => {
    expect(ids(r)).toContain('C');
    expect(byId(r, 'C').rank).toBeLessThan(byId(r, 'A').rank);
    expect(byId(r, 'C').reason).toBe('NEW_WITH_TRACTION');
  });
});

describe('mode: RANKED vs FALLBACK', () => {
  it('units sold in the window < minSalesForRanking -> FALLBACK; = -> RANKED', () => {
    expect(run([prod('a')], { sales: [sale('a', 4, 0)] }).mode).toBe(
      'FALLBACK',
    );
    expect(run([prod('a')], { sales: [sale('a', 5, 0)] }).mode).toBe('RANKED');
    expect(
      run([prod('a')], { sales: [sale('a', 2, 0), sale('a', 3, 0)] }).mode,
    ).toBe('RANKED');
  });

  it('sales outside the window do not count toward the mode', () => {
    expect(run([prod('a')], { sales: [sale('a', 50, 120)] }).mode).toBe(
      'FALLBACK',
    );
  });

  it('0 sales: never an empty list while there is stocked product', () => {
    const r = run([prod('a'), prod('b')]);
    expect(r.mode).toBe('FALLBACK');
    expect(r.salesCount).toBe(0);
    expect(r.ranked).toHaveLength(2);
  });

  it('fallback order: novelty (N desc) first, then wishlist count, then total order', () => {
    const wl = (id: string, n: number) =>
      Array.from({ length: n }, () => ({ productId: id, at: ago(1) }));
    const r = run(
      [
        prod('p1'),
        prod('p2'),
        prod('p3', { createdAt: ago(5) }),
        prod('p4', { createdAt: ago(1) }),
      ],
      { wishlist: [...wl('p1', 3), ...wl('p2', 1)] },
    );
    expect(ids(r)).toEqual(['p4', 'p3', 'p1', 'p2']);
    expect(byId(r, 'p4').reason).toBe('NEW');
    expect(byId(r, 'p3').reason).toBe('NEW');
    expect(byId(r, 'p1').reason).toBeNull();
  });

  it('fallback: wishlist 3 outranks wishlist 1 even if older wishlists decay', () => {
    const r = run([prod('x'), prod('y')], {
      wishlist: [
        { productId: 'x', at: ago(80) },
        { productId: 'x', at: ago(80) },
        { productId: 'y', at: ago(0) },
      ],
    });
    // undecayed counts: x = 2, y = 1
    expect(ids(r)).toEqual(['x', 'y']);
  });

  it('fallback keeps the hard franchise cap', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      prod(`p${i}`, { franchiseKey: 'POKEMON', createdAt: ago(i) }),
    );
    const r = run(many);
    expect(r.mode).toBe('FALLBACK');
    expect(r.ranked).toHaveLength(4);
  });
});

describe('ordering, ties and determinism', () => {
  it('ties: score DESC, then createdAt DESC, then id ASC', () => {
    const r = run(
      [
        prod('b', { createdAt: ago(200) }),
        prod('a', { createdAt: ago(200) }),
        prod('z', { createdAt: ago(150) }),
        prod('c', { createdAt: ago(300) }),
      ],
      {},
      { minSalesForRanking: 0, mmrLambda: 0 },
    );
    expect(ids(r)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('higher score wins over newer createdAt', () => {
    const r = run(
      [prod('hot'), prod('newer', { createdAt: ago(100) })],
      { sales: [sale('hot', 10, 0, 100)] },
      { mmrLambda: 0 },
    );
    expect(ids(r)[0]).toBe('hot');
  });

  it('empty products / empty events / nothing eligible', () => {
    expect(run([])).toEqual({ mode: 'FALLBACK', salesCount: 0, ranked: [] });
    expect(run([prod('a', { availableStock: 0 })]).ranked).toEqual([]);
    const r = run([prod('a')]);
    expect(r.ranked[0].rank).toBe(1);
  });

  it('empty products with minSalesForRanking = 0 is RANKED and empty', () => {
    expect(run([], {}, { minSalesForRanking: 0 })).toEqual({
      mode: 'RANKED',
      salesCount: 0,
      ranked: [],
    });
  });

  it('duplicated product ids are collapsed deterministically', () => {
    const a1 = prod('a', { createdAt: ago(100) });
    const a2 = prod('a', { createdAt: ago(50) });
    expect(ids(run([a1, a2]))).toEqual(['a']);
    expect(run([a1, a2]).ranked[0].components).toEqual(
      run([a2, a1]).ranked[0].components,
    );
  });

  // Small seeded LCG so the "random" scenario is reproducible.
  const lcg = (seed: number) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const scenario = () => {
    const rnd = lcg(42);
    const franchises = ['POKEMON', 'MTG', 'YUGIOH', 'OTHER:x'];
    const types = ['BOOSTER', 'SINGLE', 'BOX'];
    const products = Array.from({ length: 60 }, (_, i) =>
      prod(`p${String(i).padStart(2, '0')}`, {
        createdAt: ago(Math.floor(rnd() * 60)),
        franchiseKey: franchises[Math.floor(rnd() * franchises.length)],
        productType: types[Math.floor(rnd() * types.length)],
        availableStock: Math.floor(rnd() * 6),
      }),
    );
    const events: ScoringEvents = noEvents();
    for (let i = 0; i < 300; i++) {
      const p = products[Math.floor(rnd() * products.length)].id;
      events.sales.push(
        sale(p, 1 + Math.floor(rnd() * 3), Math.floor(rnd() * 30), 5),
      );
      if (i % 2) events.wishlist.push({ productId: p, at: ago(rnd() * 40) });
      if (i % 3)
        events.cartAdds.push({
          productId: p,
          day: ago(Math.floor(rnd() * 20)),
          n: 1 + Math.floor(rnd() * 3),
        });
      if (i % 4)
        events.views.push({
          productId: p,
          day: ago(Math.floor(rnd() * 20)),
          n: 1 + Math.floor(rnd() * 80),
        });
    }
    return { products, events, rnd };
  };
  const shuffled = <T>(arr: T[], rnd: () => number): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  it('same input, permuted arrays => identical result (components included)', () => {
    const { products, events, rnd } = scenario();
    const base = run(products, events);
    expect(base.ranked.length).toBeGreaterThan(10);
    for (let k = 0; k < 5; k++) {
      const r = run(shuffled(products, rnd), {
        sales: shuffled(events.sales, rnd),
        wishlist: shuffled(events.wishlist, rnd),
        cartAdds: shuffled(events.cartAdds, rnd),
        views: shuffled(events.views, rnd),
      });
      expect(r).toEqual(base);
    }
  });

  it('permutation invariance also holds in FALLBACK mode and with identical twins', () => {
    const twins = ['t1', 't2', 't3', 't4', 't5'].map((id) =>
      prod(id, { franchiseKey: id, createdAt: ago(3) }),
    );
    const rnd = lcg(7);
    const base = run(twins);
    expect(base.mode).toBe('FALLBACK');
    expect(ids(base)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    for (let k = 0; k < 5; k++) {
      expect(ids(run(shuffled(twins, rnd)))).toEqual(ids(base));
    }
  });

  it('repeated calls are identical', () => {
    const { products, events } = scenario();
    expect(run(products, events)).toEqual(run(products, events));
  });

  it('ranks are contiguous from 1 and at most K=48', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      prod(`p${String(i).padStart(3, '0')}`, { createdAt: ago(i % 30) }),
    );
    const r = run(many, {}, { minSalesForRanking: 0 });
    expect(r.ranked).toHaveLength(VITRINA_MMR_K);
    expect(r.ranked.map((x) => x.rank)).toEqual(
      Array.from({ length: VITRINA_MMR_K }, (_, i) => i + 1),
    );
  });
});

describe('component breakdown invariant', () => {
  it('sum(points) * scarcityFactor == score at 4 dp, for every product', () => {
    const { products, events } = (() => {
      const products = Array.from({ length: 40 }, (_, i) =>
        prod(`p${i}`, {
          createdAt: ago(i * 2),
          availableStock: 1 + (i % 5),
          franchiseKey: `F${i % 12}`,
        }),
      );
      const events = noEvents();
      products.forEach((p, i) => {
        events.sales.push(sale(p.id, 1 + (i % 4), i, 7.5 * (i % 3)));
        if (i % 2) events.wishlist.push({ productId: p.id, at: ago(i) });
        events.cartAdds.push({ productId: p.id, day: ago(i % 9), n: i % 4 });
        events.views.push({ productId: p.id, day: ago(i % 9), n: i * 7 });
      });
      return { products, events };
    })();
    const r = run(products, events);
    expect(r.ranked.length).toBeGreaterThan(0);
    for (const x of r.ranked) {
      const c = x.components;
      const sum =
        c.sales.points +
        c.revenue.points +
        c.velocity.points +
        c.interest.points +
        c.novelty.points;
      expect(Math.round(sum * c.scarcityFactor * 1e4)).toBe(
        Math.round(x.score * 1e4),
      );
      expect(c.score).toBe(x.score);
      expect(c.sales.points).toBeCloseTo(
        c.sales.weight * c.sales.zSmoothed,
        12,
      );
    }
  });

  it('weights are echoed and points scale with them', () => {
    const r = run(
      [prod('a'), prod('b')],
      { sales: [sale('a', 1, 0), sale('b', 2, 0)] },
      { wSales: 70, wRevenue: 0, wVelocity: 0, wInterest: 20, wNovelty: 10 },
    );
    expect(byId(r, 'a').components.sales.weight).toBe(70);
    expect(byId(r, 'a').components.sales.points).toBeCloseTo(
      70 * byId(r, 'a').components.sales.zSmoothed,
      12,
    );
  });
});

describe('MMR diversification', () => {
  // novelty-only scores: A=100 (age 0), B=90 (10), C=70 (30), D=80 (20).
  const mk = () => [
    prod('A', { createdAt: ago(0), franchiseKey: 'X', productType: 'T1' }),
    prod('B', { createdAt: ago(10), franchiseKey: 'X', productType: 'T1' }),
    prod('C', { createdAt: ago(30), franchiseKey: 'Y', productType: 'T2' }),
    prod('D', { createdAt: ago(20), franchiseKey: 'Y', productType: 'T1' }),
  ];

  it('scores are the hand-computed 100 / 90 / 80 / 70', () => {
    const r = run(mk(), {}, { ...NOVELTY_ONLY, mmrLambda: 0 });
    expect(byId(r, 'A').score).toBeCloseTo(100, 9);
    expect(byId(r, 'B').score).toBeCloseTo(90, 9);
    expect(byId(r, 'D').score).toBeCloseTo(80, 9);
    expect(byId(r, 'C').score).toBeCloseTo(70, 9);
  });

  it('lambda = 0 is pure score order', () => {
    const r = run(mk(), {}, { ...NOVELTY_ONLY, mmrLambda: 0 });
    expect(ids(r)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('lambda = 0.35 interleaves franchises/types: A, C, B, D', () => {
    // pick A. then mmr: B = .65*.9-.35*1 = .235, D = .65*.8-.35*.4 = .38,
    // C = .65*.7 = .455 -> C. then B = .235 (sim 1 with A), D = .52-.35 = .17.
    const r = run(mk(), {}, { ...NOVELTY_ONLY, mmrLambda: 0.35 });
    expect(ids(r)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('lambda = 1 ignores score except for tie-break (most dissimilar first)', () => {
    const r = run(mk(), {}, { ...NOVELTY_ONLY, mmrLambda: 1 });
    expect(ids(r)[0]).toBe('A'); // all mmr = 0 at first pick -> total order
    expect(ids(r)[1]).toBe('C'); // only candidate with sim 0
  });

  it('same-type (0.4) is penalised less than same franchise (1)', () => {
    const r = run(
      [
        prod('A', { createdAt: ago(0), franchiseKey: 'X', productType: 'T1' }),
        prod('SF', { createdAt: ago(1), franchiseKey: 'X', productType: 'T2' }),
        prod('ST', { createdAt: ago(1), franchiseKey: 'Y', productType: 'T1' }),
      ],
      {},
      { ...NOVELTY_ONLY, mmrLambda: 0.35 },
    );
    // SF/ST same score 99; SF sim 1 -> .65*.99-.35, ST sim .4 -> .65*.99-.14
    expect(ids(r)).toEqual(['A', 'ST', 'SF']);
  });

  it('hard cap: 10 products of one franchise -> at most 4', () => {
    const same = Array.from({ length: 10 }, (_, i) =>
      prod(`s${i}`, { franchiseKey: 'POKEMON', createdAt: ago(i) }),
    );
    const r = run(same, {}, { ...NOVELTY_ONLY });
    expect(r.ranked).toHaveLength(4);
    expect(ids(r)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('hard cap holds even with lambda = 0 and fills with other franchises', () => {
    const same = Array.from({ length: 10 }, (_, i) =>
      prod(`s${i}`, { franchiseKey: 'POKEMON', createdAt: ago(i) }),
    );
    const other = [
      prod('o1', { franchiseKey: 'MTG', createdAt: ago(50) }),
      prod('o2', { franchiseKey: 'YUGIOH', createdAt: ago(60) }),
    ];
    const r = run([...same, ...other], {}, { ...NOVELTY_ONLY, mmrLambda: 0 });
    expect(r.ranked).toHaveLength(6);
    expect(
      r.ranked.filter((x) => x.id.startsWith('s')).map((x) => x.id),
    ).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('maxPerFranchise is configurable; OTHER keys count per category', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) =>
        prod(`a${i}`, { franchiseKey: 'OTHER:1', createdAt: ago(i) }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        prod(`b${i}`, { franchiseKey: 'OTHER:2', createdAt: ago(i) }),
      ),
    ];
    const r = run(items, {}, { ...NOVELTY_ONLY, maxPerFranchise: 2 });
    expect(r.ranked).toHaveLength(4);
    expect(r.ranked.filter((x) => x.id.startsWith('a'))).toHaveLength(2);
    expect(r.ranked.filter((x) => x.id.startsWith('b'))).toHaveLength(2);
  });

  it('cap is applied in ranked order (the best ones of a franchise stay)', () => {
    const r = run(
      Array.from({ length: 6 }, (_, i) =>
        prod(`p${i}`, { franchiseKey: 'F', createdAt: ago(5 - i) }),
      ),
      {},
      { ...NOVELTY_ONLY, maxPerFranchise: 1 },
    );
    expect(ids(r)).toEqual(['p5']);
  });
});

describe('reason (only when true)', () => {
  const ten = (f: (i: number) => Partial<ScoringProduct>) =>
    Array.from({ length: 10 }, (_, i) =>
      prod(`p${i}`, { franchiseKey: `F${i}`, ...f(i) }),
    );

  it("TOP_SALES for the clear sales leader only (z' >= 0.8)", () => {
    const r = run(
      ten(() => ({})),
      { sales: Array.from({ length: 10 }, (_, i) => sale(`p${i}`, i + 1, 0)) },
    );
    // leader: z = .95, n = 10 -> (10*.95+1.5)/13 = 11/13 = .846
    expect(byId(r, 'p9').components.sales.zSmoothed).toBeCloseTo(11 / 13, 12);
    expect(byId(r, 'p9').reason).toBe('TOP_SALES');
    // runner-up: z = .85, n = 9 -> .7625 < .8
    expect(byId(r, 'p8').reason).not.toBe('TOP_SALES');
  });

  it('TRENDING when velocity leads but sales do not', () => {
    const products = [
      prod('T'),
      ...['x1', 'x2', 'x3', 'x4'].map((id) => prod(id)),
      ...['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => prod(id)),
    ];
    const r = run(
      products,
      {
        sales: [
          sale('T', 10, 1),
          sale('x1', 1, 1),
          sale('x2', 2, 1),
          sale('x3', 3, 1),
          sale('x4', 4, 1),
          ...['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => sale(id, 100, 20)),
        ],
      },
      { priorM: 0 },
    );
    expect(byId(r, 'T').components.sales.zSmoothed).toBeLessThan(0.8);
    expect(byId(r, 'T').components.velocity.zSmoothed).toBeCloseTo(0.9, 12);
    expect(byId(r, 'T').reason).toBe('TRENDING');
  });

  it('NEW_WITH_TRACTION: new + any sale, or new + interest >= 0.5', () => {
    const r = run(
      [
        prod('sold', { createdAt: ago(1) }),
        prod('wish', { createdAt: ago(1) }),
        prod('plain', { createdAt: ago(1) }),
        prod('other'),
      ],
      {
        sales: [sale('sold', 1, 0), sale('other', 30, 0)],
        wishlist: [{ productId: 'wish', at: ago(0) }],
      },
      { priorM: 0 },
    );
    expect(byId(r, 'sold').reason).toBe('NEW_WITH_TRACTION');
    // wish: only interest-positive -> z = .5 >= .5
    expect(byId(r, 'wish').reason).toBe('NEW_WITH_TRACTION');
    expect(byId(r, 'plain').reason).toBe('NEW');
  });

  it('NEW for a recent product with no traction; null for old and quiet', () => {
    const r = run([prod('fresh', { createdAt: ago(2) }), prod('stale')]);
    expect(byId(r, 'fresh').reason).toBe('NEW');
    expect(byId(r, 'stale').reason).toBeNull();
  });

  it('WISHLIST_FAVORITE when interest leads and is the dominant signal', () => {
    const r = run(
      ten(() => ({})),
      {
        wishlist: Array.from({ length: 10 }, (_, i) =>
          Array.from({ length: i + 1 }, () => ({
            productId: `p${i}`,
            at: ago(0),
          })),
        ).flat(),
      },
      { priorM: 0, minSalesForRanking: 0 },
    );
    expect(byId(r, 'p9').components.interest.zSmoothed).toBeCloseTo(0.95, 12);
    expect(byId(r, 'p9').reason).toBe('WISHLIST_FAVORITE');
    expect(byId(r, 'p0').reason).toBeNull();
  });

  it('no WISHLIST_FAVORITE when another signal contributes more points', () => {
    const wl = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: i + 1 }, () => ({ productId: `p${i}`, at: ago(0) })),
    ).flat();
    // p9: interest 20*.95 = 19 pts; sales alone -> z .5 -> 20 pts > 19.
    const r = run(
      ten(() => ({})),
      { wishlist: wl, sales: [sale('p9', 1, 0)] },
      { priorM: 0, minSalesForRanking: 0 },
    );
    expect(byId(r, 'p9').components.sales.points).toBeCloseTo(20, 9);
    expect(byId(r, 'p9').reason).toBeNull();
  });

  it('TOP_SALES wins over later reasons (priority)', () => {
    const r = run(
      [prod('a', { createdAt: ago(1) })],
      { sales: [sale('a', 50, 0)] },
      { priorM: 0 },
    );
    // single product: z = .5 -> not top; new with traction
    expect(byId(r, 'a').reason).toBe('NEW_WITH_TRACTION');
  });
});

describe('invalid / hostile inputs', () => {
  it('ignores NaN, zero, negative and infinite quantities', () => {
    const r = run([prod('a')], {
      sales: [
        sale('a', NaN, 0, 5),
        sale('a', 0, 0, 5),
        sale('a', -3, 0, 5),
        sale('a', Infinity, 0, 5),
        sale('a', 2, 0, 10),
      ],
    });
    expect(byId(r, 'a').components.sales.raw).toBe(2);
    expect(r.salesCount).toBe(2);
  });

  it('negative / NaN lineTotal counts as 0 revenue but keeps the units', () => {
    const r = run([prod('a')], {
      sales: [sale('a', 1, 0, -50), sale('a', 1, 0, NaN)],
    });
    expect(byId(r, 'a').components.revenue.raw).toBe(0);
    expect(byId(r, 'a').components.sales.raw).toBe(2);
  });

  it('invalid dates are ignored', () => {
    const bad = new Date('nope');
    const r = run([prod('a', { createdAt: bad })], {
      sales: [{ productId: 'a', qty: 1, lineTotal: 1, at: bad }],
      wishlist: [{ productId: 'a', at: bad }],
      cartAdds: [{ productId: 'a', day: bad, n: 1 }],
      views: [{ productId: 'a', day: bad, n: 1 }],
    });
    expect(ids(r)).toEqual(['a']);
    expect(byId(r, 'a').components.sales.raw).toBe(0);
    expect(byId(r, 'a').components.interest.raw).toBe(0);
    expect(Number.isFinite(byId(r, 'a').score)).toBe(true);
  });

  it('negative / NaN daily counts are ignored', () => {
    const r = run([prod('a')], {
      cartAdds: [
        { productId: 'a', day: ago(0), n: -4 },
        { productId: 'a', day: ago(0), n: NaN },
      ],
      views: [{ productId: 'a', day: ago(0), n: -1 }],
    });
    expect(byId(r, 'a').components.interest.raw).toBe(0);
  });

  it('never yields NaN anywhere in the output, even with weird configs', () => {
    const r = run(
      [prod('a'), prod('b', { availableStock: 1 })],
      { sales: [sale('a', 1, 0, 0)] },
      { priorM: 0, scarcityThreshold: 0, noveltyDays: 0 },
    );
    const nums = (v: unknown): number[] =>
      typeof v === 'number'
        ? [v]
        : v && typeof v === 'object'
          ? Object.values(v).flatMap(nums)
          : [];
    const all = nums(r.ranked);
    expect(all.length).toBeGreaterThan(10);
    for (const n of all) expect(Number.isFinite(n)).toBe(true);
  });

  it('rejects invalid config and invalid now', () => {
    expect(() => run([prod('a')], {}, { halfLifeDays: 0 })).toThrow(RangeError);
    expect(() => run([prod('a')], {}, { windowDays: NaN })).toThrow(RangeError);
    expect(() => run([prod('a')], {}, { wSales: -1 })).toThrow(RangeError);
    expect(() => run([prod('a')], {}, { mmrLambda: 1.5 })).toThrow(RangeError);
    expect(() => run([prod('a')], {}, { mmrLambda: NaN })).toThrow(RangeError);
    expect(() => run([prod('a')], {}, { maxPerFranchise: 0 })).toThrow(
      RangeError,
    );
    expect(() => run([prod('a')], {}, { priorM: -1 })).toThrow(RangeError);
    expect(() =>
      computeRanking({
        products: [],
        events: noEvents(),
        config: CFG,
        now: new Date('x'),
      }),
    ).toThrow(RangeError);
  });

  it('result depends on `now` only through the argument', () => {
    const input = {
      products: [prod('a', { createdAt: ago(10) })],
      events: { ...noEvents(), sales: [sale('a', 4, 0)] },
      config: CFG,
    };
    const r1 = computeRanking({ ...input, now: NOW });
    const r2 = computeRanking({
      ...input,
      now: new Date(NOW.getTime() + 14 * DAY),
    });
    expect(r1.ranked[0].components.sales.raw).toBe(4);
    expect(r2.ranked[0].components.sales.raw).toBe(2);
  });
});

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
