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
