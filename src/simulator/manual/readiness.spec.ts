import { describe, expect, it } from 'vitest';
import { evaluateReadiness, type TierCounts } from './readiness.js';
import {
  drawPack,
  InsufficientCardsError,
  type PoolCard,
  type SetPool,
} from '../pack-draw.js';
import { buildPoolFromManual } from './manual-pool.js';
import { PACK_TIERS, RARE_SLOT_TIERS, type PackTier } from '../pack-tiers.js';
import { SimulatorRarityTier } from '../../generated/prisma/enums.js';
import {
  defaultPokemonTemplate,
  type Slot,
  type Template,
} from '../simulator-defaults.js';

const T = defaultPokemonTemplate();
// default odds tiers: RARE, DOUBLE_RARE, ULTRA_RARE, ILLUSTRATION_RARE, SPECIAL_ILLUSTRATION_RARE, HYPER_RARE
const base = (): TierCounts => ({
  COMMON: 4,
  UNCOMMON: 3,
  RARE: 3,
  DOUBLE_RARE: 1,
  ULTRA_RARE: 1,
  ILLUSTRATION_RARE: 1,
  SPECIAL_ILLUSTRATION_RARE: 1,
  HYPER_RARE: 1,
});

describe('SimulatorRarityTier parity (AC2)', () => {
  it('has exactly the PACK_TIERS names', () => {
    expect(Object.values(SimulatorRarityTier).sort()).toEqual(
      [...PACK_TIERS].sort(),
    );
  });
});

describe('evaluateReadiness (AC7, AC8)', () => {
  it('empty set lists every requirement', () => {
    const r = evaluateReadiness(T, {});
    expect(r.ready).toBe(false);
    const by = Object.fromEntries(r.missing.map((m) => [m.slot, m]));
    expect(by['fixed:COMMON']).toEqual({
      slot: 'fixed:COMMON',
      tier: 'COMMON',
      required: 4,
      available: 0,
    });
    expect(by['fixed:UNCOMMON']).toMatchObject({ required: 3, available: 0 });
    expect(by['reverse']).toMatchObject({ tier: null, available: 0 });
    for (const t of RARE_SLOT_TIERS)
      expect(by[`rare:${t}`]).toMatchObject({
        tier: t,
        required: 1,
        available: 0,
      });
    expect(r.missing).toHaveLength(2 + 1 + RARE_SLOT_TIERS.length);
  });

  it('is ready with the minimum (4C + 3U + C+U+R >= 10 + 1 per odds tier)', () => {
    const c = base();
    expect(evaluateReadiness(T, c)).toEqual({ ready: true, missing: [] });
  });

  it('a single missing rare tier is reported alone', () => {
    const c = base();
    c.HYPER_RARE = 0;
    const r = evaluateReadiness(T, c);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      {
        slot: 'rare:HYPER_RARE',
        tier: 'HYPER_RARE',
        required: 1,
        available: 0,
      },
    ]);
  });

  it('a tier with odds 0 and no cards does not block', () => {
    const t: Template = {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 1 },
        { kind: 'rare', odds: { RARE: 100, DOUBLE_RARE: 0 } },
      ],
    };
    expect(
      evaluateReadiness(t, { COMMON: 1, RARE: 1, DOUBLE_RARE: 0 }).ready,
    ).toBe(true);
  });

  it('A111 edge: C+U+R of 11 fails, 12 passes (RARE odds > 0)', () => {
    // fixed C+U = 7, reverse = 2 -> need cur >= 10; but with extra rare tiers satisfied.
    const c = base();
    c.COMMON = 4;
    c.UNCOMMON = 3;
    c.RARE = 1; // cur = 8 < 9 (7+2) -> reverse (2) fails
    expect(evaluateReadiness(T, c).missing.map((m) => m.slot)).toEqual([
      'reverse',
    ]);
    c.RARE = 2; // cur = 9: rule 2 ok, rule 4 needs 10
    const r = evaluateReadiness(T, c);
    expect(r.missing).toEqual([
      { slot: 'reverse', tier: null, required: 10, available: 9 },
    ]);
    c.RARE = 3;
    expect(evaluateReadiness(T, c).ready).toBe(true);
  });

  it('A111 does not apply without RARE odds', () => {
    const t: Template = {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 2 },
        { kind: 'reverse', count: 1 },
        { kind: 'rare', odds: { DOUBLE_RARE: 100 } },
      ],
    };
    expect(evaluateReadiness(t, { COMMON: 3, DOUBLE_RARE: 1 }).ready).toBe(
      true,
    );
  });

  it('aggregates fixed slots of the same tier', () => {
    const t: Template = {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 2 },
        { kind: 'fixed', tier: 'COMMON', count: 2 },
        { kind: 'rare', odds: { DOUBLE_RARE: 100 } },
      ],
    };
    const r = evaluateReadiness(t, { COMMON: 3, DOUBLE_RARE: 1 });
    expect(r.missing).toEqual([
      { slot: 'fixed:COMMON', tier: 'COMMON', required: 4, available: 3 },
    ]);
  });

  it('rare tier also fixed: needs fixed + 1', () => {
    const t: Template = {
      slots: [
        { kind: 'fixed', tier: 'DOUBLE_RARE', count: 1 },
        { kind: 'rare', odds: { DOUBLE_RARE: 100 } },
      ],
    };
    expect(evaluateReadiness(t, { DOUBLE_RARE: 1 }).missing).toEqual([
      {
        slot: 'rare:DOUBLE_RARE',
        tier: 'DOUBLE_RARE',
        required: 2,
        available: 1,
      },
    ]);
    expect(evaluateReadiness(t, { DOUBLE_RARE: 2 }).ready).toBe(true);
  });

  it('invalid template or odds not summing 100 => TEMPLATE_INVALID', () => {
    const bad = { slots: [{ kind: 'rare', odds: { RARE: 50 } }] };
    expect(evaluateReadiness(bad, base())).toEqual({
      ready: false,
      missing: [],
      reason: 'TEMPLATE_INVALID',
    });
    expect(evaluateReadiness({ nope: 1 }, base()).reason).toBe(
      'TEMPLATE_INVALID',
    );
    expect(evaluateReadiness(null, base()).reason).toBe('TEMPLATE_INVALID');
  });
});

/** mulberry32: fixed-seed PRNG. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic `RandomInt` (min inclusive, max exclusive) so the draws are reproducible. */
function seededInt(seed: number): (min: number, max: number) => number {
  const r = prng(seed);
  return (min, max) => min + Math.floor(r() * (max - min));
}

function syntheticPool(counts: TierCounts): SetPool {
  const rows = PACK_TIERS.flatMap((tier) =>
    Array.from({ length: counts[tier] ?? 0 }, (_, i) => ({
      id: `${tier}-${i}`,
      name: `${tier} ${i}`,
      rarityTier: tier,
      number: i % 3 === 0 ? null : `${tier}-${i}`,
      imageUrl: null,
      marketPriceUsd: null,
    })),
  );
  return buildPoolFromManual(rows);
}

describe('evaluateReadiness property (AC9)', () => {
  it('ready => 1000 drawPack never throw, 10 distinct cards, rare last', () => {
    const rnd = prng(212);
    const drawRnd = seededInt(7);
    const int = (min: number, max: number) =>
      min + Math.floor(rnd() * (max - min + 1));
    let readyCases = 0;
    for (let iter = 0; iter < 300; iter++) {
      const slots: Slot[] = [];
      let total = 0;
      for (const tier of [
        'COMMON',
        'UNCOMMON',
        'RARE',
        'DOUBLE_RARE',
      ] as PackTier[])
        if (rnd() < 0.6) {
          const count = int(1, 3);
          slots.push({ kind: 'fixed', tier, count });
          total += count;
        }
      if (rnd() < 0.7) {
        const count = int(1, 3);
        slots.push({ kind: 'reverse', count });
        total += count;
      }
      const odds: Partial<Record<PackTier, number>> = {};
      const chosen = RARE_SLOT_TIERS.filter(() => rnd() < 0.5);
      if (chosen.length === 0) chosen.push('RARE');
      let left = 100;
      chosen.forEach((t, i) => {
        const w = i === chosen.length - 1 ? left : int(0, left);
        odds[t] = w;
        left -= w;
      });
      slots.push({ kind: 'rare', odds });
      total += 1;
      const tpl: Template = { slots };
      const counts: TierCounts = {};
      for (const t of PACK_TIERS) counts[t] = int(0, 6);
      const r = evaluateReadiness(tpl, counts);
      if (!r.ready) continue;
      readyCases++;
      const pool = syntheticPool(counts);
      for (let k = 0; k < 1000; k++) {
        let pack;
        try {
          pack = drawPack(pool, tpl, drawRnd);
        } catch (e) {
          if (e instanceof InsufficientCardsError)
            throw new Error(
              `iter ${iter}: ready but drawPack threw: ${JSON.stringify({ tpl, counts })}`,
              { cause: e },
            );
          throw e;
        }
        const keys = pack.map(
          (p: { card: PoolCard }) => p.card.number ?? p.card.id,
        );
        expect(pack).toHaveLength(total);
        expect(new Set(keys).size).toBe(total);
        expect(pack[pack.length - 1].isReverse).toBe(false);
      }
    }
    expect(readyCases).toBeGreaterThan(20);
  }, 60_000);

  it('default template: 1000 draws at the exact boundary counts', () => {
    const pool = syntheticPool(base());
    const boundaryRnd = seededInt(11);
    for (let i = 0; i < 1000; i++) {
      const pack = drawPack(pool, T, boundaryRnd);
      expect(pack).toHaveLength(10);
      expect(new Set(pack.map((p) => p.card.number ?? p.card.id)).size).toBe(
        10,
      );
    }
  });
});
