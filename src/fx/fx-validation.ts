import { Prisma } from '../generated/prisma/client.js';

export type FxRejectReason =
  | 'NOT_FINITE'
  | 'NOT_POSITIVE'
  | 'VARIATION_EXCEEDED'
  | 'DATE_REGRESSION'
  | 'DATE_NOT_NEWER'
  | 'OUT_OF_RANGE'
  | 'FUTURE_DATE';

export type FxEvaluation = { ok: true } | { ok: false; reason: FxRejectReason };

export interface FxEvaluationInput {
  reading: { rate: number; providerUpdatedAt: Date };
  /** Reference reading to compare with; null = nothing to compare (accept). */
  current: { rate: number; providerUpdatedAt: Date | null } | null;
  maxVariationPct: number;
  now: Date;
}

/** `Decimal(18,4)` holds < 1e14: anything that rounds to >= this overflows. */
export const FX_MAX_RATE = new Prisma.Decimal('99999999999999.9999');

/** A provider date more than this far ahead of `now` is rejected. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Story 18.1 (AD-79): PURE validation of a provider reading. No I/O, no clock
 * (`now` is injected). Equal date and equal rate is NOT a rejection (the
 * caller treats it as a no-op, see {@link isSameReading}).
 */
export function evaluateReading(input: FxEvaluationInput): FxEvaluation {
  const { reading, current, maxVariationPct, now } = input;
  if (typeof reading.rate !== 'number' || !Number.isFinite(reading.rate)) {
    return { ok: false, reason: 'NOT_FINITE' };
  }
  if (reading.rate <= 0) return { ok: false, reason: 'NOT_POSITIVE' };
  // Exact decimal arithmetic on the value that would be persisted (4 dp).
  const rate = new Prisma.Decimal(reading.rate).toDecimalPlaces(4);
  if (rate.gt(FX_MAX_RATE)) return { ok: false, reason: 'OUT_OF_RANGE' };
  if (rate.lte(0)) return { ok: false, reason: 'NOT_POSITIVE' };
  const at = reading.providerUpdatedAt.getTime();
  if (Number.isNaN(at) || at > now.getTime() + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: 'FUTURE_DATE' };
  }
  if (current) {
    if (current.providerUpdatedAt && at < current.providerUpdatedAt.getTime()) {
      return { ok: false, reason: 'DATE_REGRESSION' };
    }
    // Same provider date with a different rate: the snapshot is keyed by
    // (source, providerUpdatedAt) and cannot hold both, so the reading is
    // not applied (admin may accept it explicitly). See AD-79.
    if (
      current.providerUpdatedAt &&
      at === current.providerUpdatedAt.getTime() &&
      !new Prisma.Decimal(current.rate).toDecimalPlaces(4).equals(rate)
    ) {
      return { ok: false, reason: 'DATE_NOT_NEWER' };
    }
    if (current.rate > 0) {
      const cur = new Prisma.Decimal(current.rate);
      // |new - cur| > cur * pct / 100, all exact: 15 % exactly is accepted.
      const delta = rate.minus(cur).abs();
      const limit = cur.times(new Prisma.Decimal(maxVariationPct)).div(100);
      if (delta.gt(limit)) {
        return { ok: false, reason: 'VARIATION_EXCEEDED' };
      }
    }
  }
  return { ok: true };
}

/** Same provider timestamp and same rate (4 dp): nothing new to persist. */
export function isSameReading(
  reading: { rate: number; providerUpdatedAt: Date },
  current: { rate: number; providerUpdatedAt: Date | null } | null,
): boolean {
  return (
    !!current &&
    !!current.providerUpdatedAt &&
    current.providerUpdatedAt.getTime() ===
      reading.providerUpdatedAt.getTime() &&
    current.rate.toFixed(4) === reading.rate.toFixed(4)
  );
}

/** Story 22.1 (AD-109): default age (hours) up to which a snapshot is a valid reference. */
export const FX_REFERENCE_MAX_AGE_HOURS_DEFAULT = 96;
export const FX_REFERENCE_MAX_AGE_HOURS_MIN = 24;
export const FX_REFERENCE_MAX_AGE_HOURS_MAX = 720;

/** Confirmation tolerance between a candidate and a new reading (0.5 %). */
export const FX_CONFIRMATION_TOLERANCE_PCT = 0.5;

/**
 * Story 22.1 (AD-109): the snapshot is a CURRENT reference only when
 * `now - maxAge <= providerUpdatedAt <= now + 5 min`. Measures the provider
 * date, not `fetchedAt`. Pure (injected clock).
 */
export function selectReference<T extends { providerUpdatedAt: Date | null }>(
  latestSnapshot: T | null | undefined,
  now: Date,
  maxAgeHours: number,
): T | null {
  if (!latestSnapshot?.providerUpdatedAt) return null;
  const at = latestSnapshot.providerUpdatedAt.getTime();
  if (Number.isNaN(at)) return null;
  const min = now.getTime() - maxAgeHours * 3600 * 1000;
  const max = now.getTime() + FUTURE_TOLERANCE_MS;
  return at >= min && at <= max ? latestSnapshot : null;
}

export interface FxCandidate {
  rate: number;
  providerUpdatedAt: Date;
  reason: string;
  /** When the candidate was recorded as rejected. */
  at: Date;
}

export type FxDecision =
  | { accept: true; via: 'NO_REFERENCE' | 'WITHIN_LIMIT' | 'CONFIRMED' }
  | { accept: false; reason: FxRejectReason };

export interface FxDecisionInput {
  reading: { rate: number; providerUpdatedAt: Date };
  /** Current reference (see {@link selectReference}); null = none. */
  reference: { rate: number; providerUpdatedAt: Date | null } | null;
  /** Previous rejected reading (VARIATION_EXCEEDED) of the same source. */
  candidate: FxCandidate | null;
  maxVariationPct: number;
  now: Date;
  /**
   * Snapshot with the EXACT (source, providerUpdatedAt) key of the reading,
   * whatever its age: a different rate there is always DATE_NOT_NEWER.
   */
  collision?: { rate: number; providerUpdatedAt: Date | null } | null;
  /** Candidate max age in hours (default 96). */
  candidateMaxAgeHours?: number;
}

/**
 * Story 22.1 (AD-109): PURE decision on a reading: structural checks always
 * reject; date/variation only against a current reference; a variation-only
 * rejection is CONFIRMED by a second consistent reading with a newer date.
 */
export function decideReading(input: FxDecisionInput): FxDecision {
  const { reading, reference, candidate, maxVariationPct, now, collision } =
    input;
  const structural = evaluateReading({
    reading,
    current: null,
    maxVariationPct,
    now,
  });
  if (!structural.ok) return { accept: false, reason: structural.reason };

  const at = reading.providerUpdatedAt.getTime();
  const rate = new Prisma.Decimal(reading.rate).toDecimalPlaces(4);
  if (
    collision?.providerUpdatedAt &&
    collision.providerUpdatedAt.getTime() === at &&
    !new Prisma.Decimal(collision.rate).toDecimalPlaces(4).equals(rate)
  ) {
    return { accept: false, reason: 'DATE_NOT_NEWER' };
  }

  if (!reference) return { accept: true, via: 'NO_REFERENCE' };
  const verdict = evaluateReading({
    reading,
    current: reference,
    maxVariationPct,
    now,
  });
  if (verdict.ok) return { accept: true, via: 'WITHIN_LIMIT' };
  if (verdict.reason !== 'VARIATION_EXCEEDED') {
    return { accept: false, reason: verdict.reason };
  }

  if (
    candidate &&
    candidate.reason === 'VARIATION_EXCEEDED' &&
    candidate.rate > 0 &&
    Number.isFinite(candidate.rate) &&
    now.getTime() - candidate.at.getTime() <=
      (input.candidateMaxAgeHours ?? FX_REFERENCE_MAX_AGE_HOURS_DEFAULT) *
        3600 *
        1000 &&
    at > candidate.providerUpdatedAt.getTime()
  ) {
    const cand = new Prisma.Decimal(candidate.rate);
    const delta = rate.minus(cand).abs();
    const limit = cand.times(FX_CONFIRMATION_TOLERANCE_PCT).div(100);
    if (delta.lte(limit)) return { accept: true, via: 'CONFIRMED' };
  }
  return { accept: false, reason: 'VARIATION_EXCEEDED' };
}
