import { randomInt } from 'node:crypto';
import {
  PACK_TIERS,
  REVERSE_PRINTING_PATTERN,
  RARE_SLOT_TIERS,
  isBasicEnergyName,
  mapPackTier,
  type PackTier,
} from './pack-tiers.js';
import type { RareOdds, Template } from './simulator-defaults.js';

/** Story 16.4 (AD-67): pure pack drawing (no I/O) so it can be tested with the real RNG. */

export interface PoolRow {
  id: string;
  name: string;
  cardNumber: string | null;
  rarity: string | null;
  printing: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
  /** Market price in integer cents (null = unpriced). */
  priceCents: number | null;
}

export interface PoolCard {
  id: string;
  name: string;
  number: string | null;
  rarityRaw: string | null;
  tier: PackTier;
  imageUrl: string | null;
  priceCents: number | null;
}

export interface SetPool {
  byTier: Record<PackTier, PoolCard[]>;
  /** Cards from rows whose `printing` is reverse holo (COMMON/UNCOMMON/RARE). */
  reverse: PoolCard[];
  hasReversePrintings: boolean;
  total: number;
}

export interface DrawnCard {
  card: PoolCard;
  isReverse: boolean;
}

export type RandomInt = (min: number, max: number) => number;

export class InsufficientCardsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCardsError';
  }
}

const REVERSE_TIERS: readonly PackTier[] = ['COMMON', 'UNCOMMON', 'RARE'];
/** Descending fallback ladder: HYPER -> SIR -> IR -> ULTRA -> DOUBLE -> RARE -> UNCOMMON -> COMMON. */
const LADDER: readonly PackTier[] = [...PACK_TIERS].reverse();

export function buildPool(rows: PoolRow[]): SetPool {
  const byTier = Object.fromEntries(
    PACK_TIERS.map((t) => [t, [] as PoolCard[]]),
  ) as Record<PackTier, PoolCard[]>;
  const reverse: PoolCard[] = [];
  let hasReversePrintings = false;
  let total = 0;
  for (const r of rows) {
    const isRev =
      r.printing != null && REVERSE_PRINTING_PATTERN.test(r.printing);
    if (isRev) hasReversePrintings = true;
    if (isBasicEnergyName(r.name)) continue;
    const tier = mapPackTier(r.rarity);
    if (!tier) continue;
    const card: PoolCard = {
      id: r.id,
      name: r.name,
      number: r.cardNumber,
      rarityRaw: r.rarity,
      tier,
      imageUrl: r.imageLarge ?? r.imageSmall ?? null,
      priceCents: r.priceCents,
    };
    total++;
    if (isRev && REVERSE_TIERS.includes(tier)) reverse.push(card);
    else byTier[tier].push(card);
  }
  return { byTier, reverse, hasReversePrintings, total };
}

const keyOf = (c: PoolCard): string => c.number ?? c.id;

/** Sampling without replacement, skipping any card whose key is already used. */
function take(
  pool: PoolCard[],
  n: number,
  used: Set<string>,
  rnd: RandomInt,
): PoolCard[] {
  const out: PoolCard[] = [];
  let candidates = pool.filter((c) => !used.has(keyOf(c)));
  while (out.length < n && candidates.length > 0) {
    const i = rnd(0, candidates.length);
    const picked = candidates[i];
    used.add(keyOf(picked));
    out.push(picked);
    // Remove the pick and any other printing sharing its uniqueness key.
    const k = keyOf(picked);
    candidates = candidates.filter((c) => keyOf(c) !== k);
  }
  return out;
}

/** Takes `n` cards starting at `tier` and falling down the ladder; 422 if exhausted. */
function takeWithLadder(
  pool: SetPool,
  tier: PackTier,
  n: number,
  used: Set<string>,
  rnd: RandomInt,
): PoolCard[] {
  const out: PoolCard[] = [];
  for (const t of LADDER.slice(LADDER.indexOf(tier))) {
    out.push(...take(pool.byTier[t], n - out.length, used, rnd));
    if (out.length >= n) return out;
  }
  throw new InsufficientCardsError(
    `Not enough distinct cards to fill ${n} slot(s) from tier ${tier} down.`,
  );
}

/** Picks a tier with `randomInt(0,10000)` against cumulative odds in basis points. */
export function rollRareTier(odds: RareOdds, rnd: RandomInt): PackTier {
  const entries = RARE_SLOT_TIERS.map(
    (t) => [t, Math.round((odds[t] ?? 0) * 100)] as const,
  ).filter(([, bps]) => bps > 0);
  if (entries.length === 0)
    throw new InsufficientCardsError('Rare slot has no odds.');
  const roll = rnd(0, 10000);
  let acc = 0;
  for (const [t, bps] of entries) {
    acc += bps;
    if (roll < acc) return t;
  }
  return entries[entries.length - 1][0]; // sum within ±0.001% tolerance
}

export function drawPack(
  pool: SetPool,
  template: Template,
  rnd: RandomInt = randomInt,
): DrawnCard[] {
  const used = new Set<string>();
  const out: DrawnCard[] = [];
  for (const slot of template.slots) {
    if (slot.kind === 'fixed') {
      for (const card of takeWithLadder(pool, slot.tier, slot.count, used, rnd))
        out.push({ card, isReverse: false });
    } else if (slot.kind === 'reverse') {
      let cards: PoolCard[] = [];
      if (pool.hasReversePrintings)
        cards = take(pool.reverse, slot.count, used, rnd);
      if (cards.length < slot.count) {
        // No reverse printings (R1) or not enough: any COMMON/UNCOMMON/RARE.
        const union = REVERSE_TIERS.flatMap((t) => pool.byTier[t]);
        cards.push(...take(union, slot.count - cards.length, used, rnd));
      }
      if (cards.length < slot.count)
        throw new InsufficientCardsError('Not enough cards for reverse slot.');
      for (const card of cards) out.push({ card, isReverse: true });
    } else {
      const tier = rollRareTier(slot.odds, rnd);
      const [card] = takeWithLadder(pool, tier, 1, used, rnd);
      out.push({ card, isReverse: false });
    }
  }
  return out;
}
