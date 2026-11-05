import os from 'node:os';
import { readFileSync } from 'node:fs';
import { SAFETY_MARGIN_MS } from './retention-config.js';

/**
 * Story 20.8: the clock of a retention run.
 *
 * A purge deletes by "older than X". If the machine's clock jumps FORWARD (WSL2 after the Windows host
 * sleeps, a wrong NTP step, a virtual machine restored from a snapshot) the database's `now()` jumps
 * with it and a purge that trusts it would erase everything that is "old" by the wrong clock in one go.
 * So a run does not use `now()` directly. It uses `asOf`, which may run ahead of the previous run's `asOf` by
 * **the real time that elapsed between the two runs, measured with a clock that a wall-clock jump cannot move**:
 *
 *     asOf = dbNow                                   when dbNow <= previous.asOf + realElapsed + 5 min
 *          = previous.asOf + realElapsed             otherwise (clamped)
 *
 * `realElapsed` is the difference of the host's uptime counter (`CLOCK_BOOTTIME`: it only counts, a
 * `settimeofday`/NTP step does not touch it) between the two runs, valid while both runs saw the same
 * `boot_id` (the same boot of the same machine, whatever the number of application restarts in between).
 * Three POSTs in a row therefore advance `asOf` by the seconds that passed, not by a fixed amount per run
 * (the first version capped the advance per RUN: 3 POSTs moved it 9 days).
 *
 * When the elapsed time CANNOT be verified (the previous run is from another boot or another machine, the
 * machine was rebooted, it is the first run after this release, or the platform has no `boot_id`) the run
 * may advance by `RETENTION_MAX_CLOCK_ADVANCE_HOURS` (72 h) at most. That is the answer to "the machine was
 * off for 30 days: may the purge advance?": a reboot after a long outage and a clock that jumped 30 days look
 * the same from inside, so it advances 72 h and stops there (over-retention, never early deletion). The lag
 * (database clock minus `asOf`) is logged as a WARN in every run and `clockClamped` is saved on the run row
 * (`GET /admin/retention/runs`) and in `RETENTION_PURGE_RUN`. If the outage was REAL, the operator says so once:
 * `RETENTION_CLOCK_RESYNC=true` makes the first clamped run of that process adopt the database clock (and the
 * WARN says to remove the variable). Without it the lag is permanent: that is the price of never trusting a
 * clock that may have jumped, and it is documented in docs/deployment.md 20.5.
 *
 * The first run ever has no previous run: it uses the database clock (nothing to compare with).
 * A clock that goes BACKWARD only makes the purge more cautious (`asOf` is the smaller one).
 *
 * Then every cut-off is `asOf - period - SAFETY_MARGIN_MS` (see `marginalClock`): nothing is deleted before
 * its period has surely elapsed even if the application clock and the database clock disagree.
 */
export interface ClockAnchor {
  /** Identity of the boot of the machine (`/proc/sys/kernel/random/boot_id`); null when the platform has none. */
  bootId: string | null;
  /** The host's uptime counter in ms (not affected by changes of the wall clock); null when unknown. */
  uptimeMs: number | null;
}

/** Where the monotonic reading comes from. Injected so a test can move the clocks independently. */
export interface MonotonicSource {
  anchor(): ClockAnchor;
}

export const RETENTION_MONOTONIC = Symbol('RETENTION_MONOTONIC');

let cachedBootId: string | null | undefined;
function readBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    cachedBootId = /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

/** The real thing: `boot_id` of the kernel and `os.uptime()` (CLOCK_BOOTTIME; unaffected by clock steps). */
export const hostMonotonicSource: MonotonicSource = {
  anchor() {
    const bootId = readBootId();
    return {
      bootId,
      uptimeMs: bootId ? Math.round(os.uptime() * 1000) : null,
    };
  },
};

/** The previous run's clock, as stored in `Retention_Runs`. */
export interface PreviousClock extends ClockAnchor {
  effectiveNow: Date;
}

export type ClockBasis = 'first' | 'verified' | 'unverified' | 'resync';

export interface EffectiveClock {
  asOf: Date;
  /** The database clock was ahead of what the previous run allows, so `asOf` is the capped value. */
  clamped: boolean;
  basis: ClockBasis;
  /** Database clock minus `asOf` (>= 0 when the run lags it), ms. */
  lagMs: number;
}

/** The database clock may be this far ahead of `previous + elapsed` before it counts as a jump (ordinary drift). */
export const CLOCK_DRIFT_TOLERANCE_MS = 5 * 60_000;

export interface EffectiveClockInput {
  dbNow: Date;
  previous: PreviousClock | null;
  /** The reading taken at this run's start. */
  current: ClockAnchor;
  /** `RETENTION_MAX_CLOCK_ADVANCE_HOURS`: the advance allowed when the elapsed time cannot be verified. */
  maxAdvanceHours: number;
  /** `RETENTION_CLOCK_RESYNC` and not yet used by this process: adopt the database clock instead of capping. */
  resync?: boolean;
}

export function effectiveClock(i: EffectiveClockInput): EffectiveClock {
  const { dbNow, previous, current } = i;
  const result = (
    asOf: Date,
    clamped: boolean,
    basis: ClockBasis,
  ): EffectiveClock => ({
    asOf,
    clamped,
    basis,
    lagMs: Math.max(0, dbNow.getTime() - asOf.getTime()),
  });
  if (!previous) return result(dbNow, false, 'first');

  const verified =
    previous.bootId !== null &&
    previous.bootId === current.bootId &&
    previous.uptimeMs !== null &&
    current.uptimeMs !== null &&
    current.uptimeMs >= previous.uptimeMs;

  let limit: Date;
  let tolerance: number;
  if (verified) {
    limit = new Date(
      previous.effectiveNow.getTime() +
        ((current.uptimeMs as number) - (previous.uptimeMs as number)),
    );
    tolerance = CLOCK_DRIFT_TOLERANCE_MS;
  } else {
    limit = new Date(
      previous.effectiveNow.getTime() + i.maxAdvanceHours * 3_600_000,
    );
    tolerance = 0;
  }
  const basis: ClockBasis = verified ? 'verified' : 'unverified';
  if (dbNow.getTime() <= limit.getTime() + tolerance)
    return result(dbNow, false, basis);
  if (i.resync) return result(dbNow, false, 'resync');
  return result(limit, true, basis);
}

/** `asOf` minus the safety margin: the instant from which every period of every task is counted back. */
export const marginalClock = (asOf: Date): Date =>
  new Date(asOf.getTime() - SAFETY_MARGIN_MS);
