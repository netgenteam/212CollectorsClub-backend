import { describe, expect, it } from 'vitest';
import {
  InsufficientCardsError,
  buildPool,
  drawPack,
  type PoolRow,
} from './pack-draw.js';
import { defaultPokemonTemplate } from './simulator-defaults.js';
import { PACK_TIERS, type PackTier } from './pack-tiers.js';
import {
  SimulatorPoolCache,
  POOL_MAX_SETS,
  POOL_TTL_MS,
} from './pool-cache.js';

const RAW: Record<PackTier, string> = {
  COMMON: 'Common',
  UNCOMMON: 'Uncommon',
  RARE: 'Rare',
  DOUBLE_RARE: 'Double Rare',
  ULTRA_RARE: 'Ultra Rare',
  ILLUSTRATION_RARE: 'Illustration Rare',
  SPECIAL_ILLUSTRATION_RARE: 'Special Illustration Rare',
  HYPER_RARE: 'Hyper Rare',
};
const SIZES: Record<PackTier, number> = {
  COMMON: 40,
  UNCOMMON: 30,
  RARE: 20,
  DOUBLE_RARE: 8,
  ULTRA_RARE: 6,
  ILLUSTRATION_RARE: 5,
  SPECIAL_ILLUSTRATION_RARE: 4,
  HYPER_RARE: 3,
};

function rows(opts: { skip?: PackTier[]; reverse?: boolean } = {}): PoolRow[] {
  const out: PoolRow[] = [];
  let n = 0;
  for (const tier of PACK_TIERS) {
    if (opts.skip?.includes(tier)) continue;
    for (let i = 0; i < SIZES[tier]; i++) {
      n++;
      const base = {
        name: `Card ${n}`,
        cardNumber: String(n),
        rarity: RAW[tier],
        imageSmall: `s${n}`,
        imageLarge: n % 2 ? `l${n}` : null,
        priceCents: n % 5 === 0 ? null : n * 10,
      };
      out.push({ id: `id-${n}`, printing: 'Normal', ...base });
      // A second printing sharing the same cardNumber must never co-occur.
      if (opts.reverse && ['COMMON', 'UNCOMMON', 'RARE'].includes(tier))
        out.push({ id: `id-${n}-rev`, printing: 'Reverse Holofoil', ...base });
      else if (i % 4 === 0)
        out.push({ id: `id-${n}-b`, printing: 'Holofoil', ...base });
    }
  }
  return out;
}

describe('drawPack', () => {
  it('1000 packs with the real RNG: 10 cards, no duplicates, rare last, odds within tolerance', () => {
    for (const reverse of [false, true]) {
      const pool = buildPool(rows({ reverse }));
      const tpl = defaultPokemonTemplate();
      const odds = tpl.slots[3].kind === 'rare' ? tpl.slots[3].odds : {};
      const counts: Record<string, number> = {};
      const N = 1000;
      for (let i = 0; i < N; i++) {
        const pack = drawPack(pool, tpl);
        expect(pack).toHaveLength(10);
        const keys = pack.map((d) => d.card.number ?? d.card.id);
        expect(new Set(keys).size).toBe(10);
        const last = pack[9];
        expect(last.isReverse).toBe(false);
        counts[last.card.tier] = (counts[last.card.tier] ?? 0) + 1;
        expect(pack.slice(0, 4).every((d) => d.card.tier === 'COMMON')).toBe(
          true,
        );
        expect(pack.slice(4, 7).every((d) => d.card.tier === 'UNCOMMON')).toBe(
          true,
        );
        expect(pack.slice(7, 9).every((d) => d.isReverse)).toBe(true);
        if (reverse)
          expect(pack.slice(7, 9).every((d) => /-rev$/.test(d.card.id))).toBe(
            true,
          );
      }
      // 4 sigma (not 3): a 3-sigma band over 6 tiers fails ~1.6% of runs by chance.
      for (const [tier, pct] of Object.entries(odds)) {
        const p = pct / 100;
        const sigma = Math.sqrt(N * p * (1 - p));
        expect(Math.abs((counts[tier] ?? 0) - N * p)).toBeLessThanOrEqual(
          4 * sigma,
        );
      }
    }
  });

  it('without reverse printings the reverse slot uses COMMON/UNCOMMON/RARE flagged isReverse', () => {
    const pool = buildPool(rows());
    expect(pool.hasReversePrintings).toBe(false);
    const pack = drawPack(pool, defaultPokemonTemplate());
    for (const d of pack.slice(7, 9)) {
      expect(d.isReverse).toBe(true);
      expect(['COMMON', 'UNCOMMON', 'RARE']).toContain(d.card.tier);
    }
  });

  it('with reverse printings, those rows leave the normal pools', () => {
    const pool = buildPool(rows({ reverse: true }));
    expect(pool.hasReversePrintings).toBe(true);
    expect(pool.reverse.length).toBe(90);
    expect(pool.byTier.COMMON.every((c) => !/rev/.test(c.id))).toBe(true);
  });

  it('degrades the rare slot without error when HYPER/SIR tiers are missing', () => {
    const pool = buildPool(
      rows({ skip: ['HYPER_RARE', 'SPECIAL_ILLUSTRATION_RARE'] }),
    );
    const tpl = defaultPokemonTemplate();
    for (let i = 0; i < 300; i++) {
      const pack = drawPack(pool, tpl);
      expect(pack).toHaveLength(10);
      expect(['HYPER_RARE', 'SPECIAL_ILLUSTRATION_RARE']).not.toContain(
        pack[9].card.tier,
      );
    }
  });

  it('throws InsufficientCardsError when the ladder is exhausted', () => {
    const pool = buildPool(rows().slice(0, 3)); // 3 commons-ish only
    expect(() => drawPack(pool, defaultPokemonTemplate())).toThrow(
      InsufficientCardsError,
    );
  });

  it('excludes promo, null rarity and basic energy; unpriced stay in pool', () => {
    const pool = buildPool([
      {
        id: 'a',
        name: 'Basic Fire Energy',
        cardNumber: '1',
        rarity: 'Common',
        printing: null,
        imageSmall: null,
        imageLarge: null,
        priceCents: 1,
      },
      {
        id: 'b',
        name: 'X',
        cardNumber: '2',
        rarity: 'Promo',
        printing: null,
        imageSmall: null,
        imageLarge: null,
        priceCents: 1,
      },
      {
        id: 'c',
        name: 'Y',
        cardNumber: '3',
        rarity: null,
        printing: null,
        imageSmall: null,
        imageLarge: null,
        priceCents: 1,
      },
      {
        id: 'd',
        name: 'Z',
        cardNumber: '4',
        rarity: 'Common',
        printing: null,
        imageSmall: 's',
        imageLarge: 'l',
        priceCents: null,
      },
    ]);
    expect(pool.total).toBe(1);
    expect(pool.byTier.COMMON[0].imageUrl).toBe('l');
  });
});

describe('SimulatorPoolCache', () => {
  const v = (setId: string) => ({
    gameSlug: 'g',
    setId,
    setName: setId,
    pool: buildPool([]),
  });
  it('expires after TTL, caps at 20 sets and clears (notifying listeners)', () => {
    const c = new SimulatorPoolCache();
    c.set('a', v('a'), 0);
    expect(c.get('a', POOL_TTL_MS)).toBeDefined();
    expect(c.get('a', POOL_TTL_MS + 1)).toBeUndefined();
    for (let i = 0; i < POOL_MAX_SETS + 5; i++) c.set(`k${i}`, v(`k${i}`));
    expect(c.size()).toBe(POOL_MAX_SETS);
    expect(c.get('k0')).toBeUndefined();
    let called = 0;
    c.onClear(() => called++);
    c.clear();
    expect(c.size()).toBe(0);
    expect(called).toBe(1);
  });
});
