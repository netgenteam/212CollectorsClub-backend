import { ApiException } from '../../common/api-exception.js';
import { PACK_TIERS, RARE_SLOT_TIERS, type PackTier } from '../pack-tiers.js';
import { checkOddsSum, parseTemplate } from '../simulator-config.validation.js';

/** Story 22.3 (AD-108): pure sufficiency evaluator of a manual set against its template. */

export type ReadinessSlot =
  `fixed:${PackTier}` | 'reverse' | `rare:${PackTier}`;

export interface ReadinessMissing {
  slot: ReadinessSlot;
  /** null for `reverse`. */
  tier: PackTier | null;
  required: number;
  available: number;
}

export interface Readiness {
  ready: boolean;
  missing: ReadinessMissing[];
  reason?: 'TEMPLATE_INVALID';
}

export type TierCounts = Partial<Record<PackTier, number>>;

const NON_RARE: readonly PackTier[] = ['COMMON', 'UNCOMMON', 'RARE'];

export function evaluateReadiness(
  template: unknown,
  countsByTier: TierCounts,
): Readiness {
  let t;
  try {
    t = parseTemplate(template, 'template');
    checkOddsSum(t, 'template');
  } catch (e) {
    if (e instanceof ApiException)
      return { ready: false, missing: [], reason: 'TEMPLATE_INVALID' };
    throw e;
  }
  const counts = (tier: PackTier): number => countsByTier[tier] ?? 0;
  const missing: ReadinessMissing[] = [];

  // Fixed slots of the same tier share `used` in the engine: aggregate them.
  const fixed = Object.fromEntries(PACK_TIERS.map((p) => [p, 0])) as Record<
    PackTier,
    number
  >;
  let reverseTotal = 0;
  let odds: Partial<Record<PackTier, number>> = {};
  for (const s of t.slots) {
    if (s.kind === 'fixed') fixed[s.tier] += s.count;
    else if (s.kind === 'reverse') reverseTotal += s.count;
    else odds = s.odds;
  }

  // (1) enough cards for each fixed tier.
  for (const tier of PACK_TIERS)
    if (fixed[tier] > 0 && counts(tier) < fixed[tier])
      missing.push({
        slot: `fixed:${tier}`,
        tier,
        required: fixed[tier],
        available: counts(tier),
      });

  // (2) reverse slots draw from the C/U/R union minus what fixed slots consume.
  const cur = NON_RARE.reduce((a, p) => a + counts(p), 0);
  const fixedCur = NON_RARE.reduce((a, p) => a + fixed[p], 0);
  if (reverseTotal > 0 && cur - fixedCur < reverseTotal)
    missing.push({
      slot: 'reverse',
      tier: null,
      required: fixedCur + reverseTotal,
      available: cur,
    });

  // (3) one spare card (beyond the fixed ones) per tier the rare slot can roll.
  for (const tier of RARE_SLOT_TIERS)
    if ((odds[tier] ?? 0) > 0 && counts(tier) - fixed[tier] < 1)
      missing.push({
        slot: `rare:${tier}`,
        tier,
        required: fixed[tier] + 1,
        available: counts(tier),
      });

  // (4) A111: the reverse slot may consume every RARE and the engine then falls down the ladder.
  if (
    (odds.RARE ?? 0) > 0 &&
    reverseTotal > 0 &&
    cur < fixedCur + reverseTotal + 1 &&
    !missing.some((m) => m.slot === 'reverse')
  )
    missing.push({
      slot: 'reverse',
      tier: null,
      required: fixedCur + reverseTotal + 1,
      available: cur,
    });

  return { ready: missing.length === 0, missing };
}
