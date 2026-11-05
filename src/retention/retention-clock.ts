import os from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SAFETY_MARGIN_MS } from './retention-config.js';

/**
 * Story 20.8: the clock of a retention run.
 *
 * A purge deletes by "older than X". If the machine's clock jumps FORWARD (WSL2 after the Windows host
 * sleeps, a wrong NTP step, a virtual machine restored from a snapshot) the database's `now()` jumps
 * with it and a purge that trusts it would erase everything that is "old" by the wrong clock in one go.
 * And if the machine was REALLY down for days, a purge that never trusts it again keeps data past its
 * promised period for good. A jump and an outage look the same from inside, so the run does neither extreme:
 * it adopts the database clock SLOWLY, at a rate bounded by the real time that passes.
 *
 * A run does not use `now()` directly. It uses `asOf`:
 *
 *     real     = host uptime elapsed between the previous run and this one (see below)
 *     recover  = min(real, RETENTION_MAX_CLOCK_ADVANCE_HOURS)
 *     limit    = previous.asOf + real + recover
 *     asOf     = dbNow     when dbNow <= limit + 5 min        (no lag, or a lag that this run closes)
 *              = limit     otherwise                          (clamped: the lag shrinks by `recover`)
 *
 * So `asOf` follows real time (`real`) and ALSO closes the lag at the same rate again, i.e. it runs at 2x real
 * time until it reaches the database clock. The speed depends on the real time that passed, never on the number
 * of runs: three POSTs in a row advance it by 2x the seconds between them. Time to catch up = the lag itself
 * (a lag of 72 h closes in about 3 days, one of 30 days in about 30 days). A jump that was FALSE is adopted the
 * same way, gradually: the purge never erases a whole jump's worth at once, and it never stays behind for good.
 *
 * `real` is the difference of the host's uptime counter (`CLOCK_BOOTTIME`: it only counts, a
 * `settimeofday`/NTP step does not touch it) between the two runs, valid while both runs saw the same
 * `boot_id` (the same boot of the same machine, whatever the number of application restarts or container
 * restarts in between). When it CANNOT be verified (another boot, another machine, a row from before the anchor
 * existed) the only thing proven is a LOWER bound: the previous run happened before this boot, so at least the
 * current uptime has passed. `real` is then `min(current uptime, RETENTION_MAX_CLOCK_ADVANCE_HOURS)`: the first
 * run after a reboot advances by minutes, not by the clock's word (the first version trusted up to 72 h there,
 * and a restart 12 h after a run with the clock 60 h ahead purged 60 h early). The cap exists because the previous
 * run may come from ANOTHER machine with a long uptime (a restored database): the credit never exceeds 72 h.
 * A platform without `boot_id` uses the uptime of the process itself (a per-process anchor): a restart is
 * "unverified", the run in a long-lived process is verified.
 *
 * Cost: a machine that is rebooted before EVERY daily run (so every run is "unverified" with a short uptime)
 * advances only minutes per run and the lag grows; it is logged as a WARN in every run. Over-retention, visible.
 *
 * The lag (database clock minus `asOf`) is logged as a WARN in every clamped run and `clockClamped` is saved on the
 * run row (`GET /admin/retention/runs`) and in `RETENTION_PURGE_RUN`. There is no switch to skip the recovery
 * (`RETENTION_CLOCK_RESYNC` was removed: with the automatic recovery it only offered a way to purge early).
 *
 * The first run ever has no previous run: it uses the database clock (nothing to compare with).
 * A clock that goes BACKWARD (or a previous `effectiveNow` that is in the FUTURE of the database clock) makes
 * `dbNow <= limit`: `asOf` is the database clock, which only makes the purge more cautious, and the next run
 * starts from there (it cannot get stuck behind a future value).
 *
 * The `usage_logs` task is the exception (`tasks/delegated.tasks.ts`): its cut-off uses the database clock, not
 * `asOf`, because Angel's priority there is deleting the log on time.
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

/** Identity of THIS process, the anchor on a platform with no `boot_id` (the uptime is then the process's own). */
const PROCESS_ANCHOR = `proc-${randomUUID()}`;

/**
 * The real thing: `boot_id` of the kernel and `os.uptime()` (CLOCK_BOOTTIME; unaffected by clock steps).
 * Without a `boot_id` (not Linux): a per-process id and `process.uptime()` (monotonic), so runs of the same
 * process are still measured and a restart is "unverified".
 */
export const hostMonotonicSource: MonotonicSource = {
  anchor() {
    const bootId = readBootId();
    return bootId
      ? { bootId, uptimeMs: Math.round(os.uptime() * 1000) }
      : {
          bootId: PROCESS_ANCHOR,
          uptimeMs: Math.round(process.uptime() * 1000),
        };
  },
};

/** The previous run's clock, as stored in `Retention_Runs`. */
export interface PreviousClock extends ClockAnchor {
  effectiveNow: Date;
}

export type ClockBasis = 'first' | 'verified' | 'unverified';

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
  /**
   * `RETENTION_MAX_CLOCK_ADVANCE_HOURS`: the most a run may add on top of the real time, both as lag recovery and
   * as credit for elapsed time that cannot be verified.
   */
  maxAdvanceHours: number;
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

  const maxMs = i.maxAdvanceHours * 3_600_000;
  const verified =
    previous.bootId !== null &&
    previous.bootId === current.bootId &&
    previous.uptimeMs !== null &&
    current.uptimeMs !== null &&
    current.uptimeMs >= previous.uptimeMs;

  let realMs: number;
  if (verified) {
    realMs = (current.uptimeMs as number) - (previous.uptimeMs as number);
  } else {
    // Lower bound only: the previous run was before this boot (or this process), so at least the uptime has passed.
    realMs = current.uptimeMs === null ? 0 : Math.min(current.uptimeMs, maxMs);
  }
  const recoverMs = Math.min(realMs, maxMs);
  const limit = new Date(previous.effectiveNow.getTime() + realMs + recoverMs);
  const basis: ClockBasis = verified ? 'verified' : 'unverified';
  if (dbNow.getTime() <= limit.getTime() + CLOCK_DRIFT_TOLERANCE_MS)
    return result(dbNow, false, basis);
  return result(limit, true, basis);
}

/** `asOf` minus the safety margin: the instant from which every period of every task is counted back. */
export const marginalClock = (asOf: Date): Date =>
  new Date(asOf.getTime() - SAFETY_MARGIN_MS);
