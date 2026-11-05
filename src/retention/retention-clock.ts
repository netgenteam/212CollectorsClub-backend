import { SAFETY_MARGIN_MS } from './retention-config.js';

/**
 * Story 20.8: the clock of a retention run.
 *
 * A purge deletes by "older than X". If the machine's clock jumps FORWARD (WSL2 after the Windows host
 * sleeps, a wrong NTP step, a virtual machine restored from a snapshot) the database's `now()` jumps
 * with it and a purge that trusts it would erase everything that is "old" by the wrong clock in one go.
 * So a run does not use `now()` directly:
 *
 *     asOf = min(databaseNow, previousRun.effectiveNow + RETENTION_MAX_CLOCK_ADVANCE_HOURS)
 *
 * The first run ever has no previous run: it uses the database clock (nothing to compare with).
 * A clock that goes BACKWARD only makes the purge more cautious (`asOf` is the smaller one).
 * The price: after an outage longer than the cap the purge catches up by the cap per run (a day's run
 * advances up to 72 h by default) instead of at once. That is over-retention for a few days, never
 * early deletion; the run records `clockClamped` so the admin can see it.
 *
 * Then every cut-off is `asOf - period - SAFETY_MARGIN_MS` (see `cutoffOf`): nothing is deleted before
 * its period has surely elapsed even if the application clock and the database clock disagree.
 */
export interface EffectiveClock {
  asOf: Date;
  /** The database clock was ahead of what the previous run allows, so `asOf` is the capped value. */
  clamped: boolean;
}

export function effectiveClock(
  dbNow: Date,
  previousEffectiveNow: Date | null,
  maxAdvanceHours: number,
): EffectiveClock {
  if (!previousEffectiveNow) return { asOf: dbNow, clamped: false };
  const limit = new Date(
    previousEffectiveNow.getTime() + maxAdvanceHours * 3_600_000,
  );
  if (dbNow.getTime() <= limit.getTime())
    return { asOf: dbNow, clamped: false };
  return { asOf: limit, clamped: true };
}

/** `asOf` minus the safety margin: the instant from which every period of every task is counted back. */
export const marginalClock = (asOf: Date): Date =>
  new Date(asOf.getTime() - SAFETY_MARGIN_MS);
