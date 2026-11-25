import { PACK_TIERS, type PackTier } from '../pack-tiers.js';
import type { PoolCard, SetPool } from '../pack-draw.js';

/** Story 22.3 (AD-106/108): manual card row -> `SetPool` that `drawPack` consumes unchanged. */
export interface ManualCardRow {
  id: string;
  name: string;
  rarityTier: PackTier;
  number: string | null;
  imageUrl: string | null;
  /** Prisma `Decimal` (has `toNumber`/string form), number or null. */
  marketPriceUsd: { toString(): string } | number | string | null;
}

function toPriceCents(v: ManualCardRow['marketPriceUsd']): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function buildPoolFromManual(rows: ManualCardRow[]): SetPool {
  const byTier = Object.fromEntries(
    PACK_TIERS.map((t) => [t, [] as PoolCard[]]),
  ) as Record<PackTier, PoolCard[]>;
  for (const r of rows)
    byTier[r.rarityTier].push({
      id: r.id,
      name: r.name,
      number: r.number,
      rarityRaw: r.rarityTier,
      tier: r.rarityTier,
      imageUrl: r.imageUrl,
      priceCents: toPriceCents(r.marketPriceUsd),
    });
  return {
    byTier,
    reverse: [],
    hasReversePrintings: false,
    total: rows.length,
  };
}
