/**
 * Story 16.3 (AD-66): rarity tiers of the pack simulator and the raw-rarity
 * -> tier mapping. `mapRarity` (tcg-mappings.ts) only has 6 values and loses
 * Illustration/Special Illustration/Hyper, hence this dedicated mapping.
 *
 * UNVERIFIED ASSUMPTION (f / R-a): the raw rarity strings and the reverse
 * holo `printing` value below come from knowledge of Pokemon Scarlet &
 * Violet, NOT from real tcgapi data (the local DB had 0 `Master_Cards` when
 * this was written). After the FIRST REAL ingestion, validate with:
 *   SELECT rarity, count(*) FROM "Master_Cards" WHERE "gameSlug"='pokemon'
 *     GROUP BY 1 ORDER BY 2 DESC;
 *   SELECT DISTINCT printing FROM "Master_Cards";
 * and review `unmappedRarities` / `hasReversePrintings` in
 * `GET /admin/simulator/sets`. Adjust ONLY the tables below
 * (EXACT_TIERS / FALLBACK_RULES / REVERSE_PRINTING_PATTERN). See
 * docs/deployment.md ("Simulator: validating rarity mapping").
 */
export const PACK_TIERS = [
  'COMMON',
  'UNCOMMON',
  'RARE',
  'DOUBLE_RARE',
  'ULTRA_RARE',
  'ILLUSTRATION_RARE',
  'SPECIAL_ILLUSTRATION_RARE',
  'HYPER_RARE',
] as const;

export type PackTier = (typeof PACK_TIERS)[number];

/** Tiers a `rare` slot can roll (RARE..HYPER_RARE). */
export const RARE_SLOT_TIERS: readonly PackTier[] = PACK_TIERS.slice(2);

const EXACT_TIERS: Record<string, PackTier> = {
  common: 'COMMON',
  uncommon: 'UNCOMMON',
  rare: 'RARE',
  'rare holo': 'RARE',
  'holo rare': 'RARE',
  'shiny rare': 'RARE',
  'double rare': 'DOUBLE_RARE',
  'ultra rare': 'ULTRA_RARE',
  'ace spec rare': 'ULTRA_RARE',
  'shiny ultra rare': 'ULTRA_RARE',
  'rare ultra': 'ULTRA_RARE',
  'illustration rare': 'ILLUSTRATION_RARE',
  'special illustration rare': 'SPECIAL_ILLUSTRATION_RARE',
  'hyper rare': 'HYPER_RARE',
  'secret rare': 'HYPER_RARE',
  'rare secret': 'HYPER_RARE',
};

/** Ordered from most to least specific ("special illustration" contains "illustration"). */
const FALLBACK_RULES: readonly [RegExp, PackTier][] = [
  [/special illustration/, 'SPECIAL_ILLUSTRATION_RARE'],
  [/illustration/, 'ILLUSTRATION_RARE'],
  [/hyper|secret/, 'HYPER_RARE'],
  [/ultra|ace spec/, 'ULTRA_RARE'],
  [/double rare/, 'DOUBLE_RARE'],
  [/\buncommon\b/, 'UNCOMMON'],
  [/\bcommon\b/, 'COMMON'],
  [/\brare\b/, 'RARE'],
];

/** `null` = excluded from packs (promo, null, empty or unknown). */
export function mapPackTier(raw: string | null | undefined): PackTier | null {
  const norm = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm || /\bpromo\b/.test(norm)) return null;
  const exact = EXACT_TIERS[norm];
  if (exact) return exact;
  for (const [re, tier] of FALLBACK_RULES) if (re.test(norm)) return tier;
  return null;
}

const BASIC_ENERGY = /^basic .* energy$/i;

/** Basic energy cards never enter the pack pool. */
export function isBasicEnergyName(name: string | null | undefined): boolean {
  return BASIC_ENERGY.test((name ?? '').trim());
}

/** Unverified (f): how tcgapi labels reverse holo `printing`. */
export const REVERSE_PRINTING_PATTERN = /reverse/i;
export const REVERSE_PRINTING_SQL_REGEX = 'reverse';
