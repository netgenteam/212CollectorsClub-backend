import {
  CLOCK_DRIFT_TOLERANCE_MS,
  effectiveClock,
  hostMonotonicSource,
  marginalClock,
} from './retention-clock.js';
import type { ClockAnchor, PreviousClock } from './retention-clock.js';
import { SAFETY_MARGIN_MS } from './retention-config.js';

const T = (iso: string) => new Date(iso);
const H = 3_600_000;
const DAY = 24 * H;

/**
 * A model of the two independent clocks: the WALL clock (what `now()` returns, and what a jump moves) and the
 * host UPTIME counter (what a jump does not move). A "machine" advances both by the real time that passes;
 * `jump()` moves only the wall clock; `reboot()` gives a new boot id.
 */
class Machine {
  wallMs: number;
  uptimeMs: number;
  bootId: string;
  constructor(wallIso: string, boot = 'boot-A', uptimeMs = 1_000_000) {
    this.wallMs = Date.parse(wallIso);
    this.uptimeMs = uptimeMs;
    this.bootId = boot;
  }
  pass(ms: number) {
    this.wallMs += ms;
    this.uptimeMs += ms;
  }
  jump(ms: number) {
    this.wallMs += ms;
  }
  reboot(boot: string) {
    this.bootId = boot;
    this.uptimeMs = 5_000;
  }
  anchor(): ClockAnchor {
    return { bootId: this.bootId, uptimeMs: this.uptimeMs };
  }
  get dbNow() {
    return new Date(this.wallMs);
  }
}

/** What the service does: compute, then store (effectiveNow + anchor) for the next run. */
function runOn(
  m: Machine,
  previous: PreviousClock | null,
  opts: { maxAdvanceHours?: number; resync?: boolean } = {},
) {
  const clock = effectiveClock({
    dbNow: m.dbNow,
    previous,
    current: m.anchor(),
    maxAdvanceHours: opts.maxAdvanceHours ?? 72,
    resync: opts.resync,
  });
  const stored: PreviousClock = { effectiveNow: clock.asOf, ...m.anchor() };
  return { clock, stored };
}

describe('retention clock (Story 20.8: a clock jump does not bring the purge forward)', () => {
  it('the first run has nothing to compare with: the database clock', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const { clock } = runOn(m, null);
    expect(clock).toMatchObject({ clamped: false, basis: 'first', lagMs: 0 });
    expect(clock.asOf).toEqual(T('2026-11-04T04:30:00Z'));
  });

  it('a normal day later (same boot) is used as is', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(DAY);
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(false);
    expect(b.clock.basis).toBe('verified');
    expect(b.clock.asOf).toEqual(m.dbNow);
  });

  it('a few minutes of drift between the clocks is not a jump', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(DAY);
    m.jump(CLOCK_DRIFT_TOLERANCE_MS); // exactly at the tolerance
    expect(runOn(m, a.stored).clock.clamped).toBe(false);
    m.jump(1);
    expect(runOn(m, a.stored).clock.clamped).toBe(true);
  });

  it('REPRODUCTION of the QA finding: a +48 h jump and three POSTs in a row advance asOf by the real seconds, not +3/+6/+9 days', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const first = runOn(m, null);
    m.pass(10_000);
    m.jump(48 * H); // the machine clock jumped 48 h forward
    const r1 = runOn(m, first.stored);
    expect(r1.clock.clamped).toBe(true);
    // the real time since the previous run is 10 s: asOf moved by 10 s, not by 48 h
    expect(r1.clock.asOf.getTime() - first.clock.asOf.getTime()).toBe(10_000);
    m.pass(5_000);
    const r2 = runOn(m, r1.stored);
    m.pass(5_000);
    const r3 = runOn(m, r2.stored);
    expect(r2.clock.asOf.getTime() - r1.clock.asOf.getTime()).toBe(5_000);
    expect(r3.clock.asOf.getTime() - r2.clock.asOf.getTime()).toBe(5_000);
    expect(r3.clock.clamped).toBe(true);
    expect(r3.clock.asOf.getTime() - first.clock.asOf.getTime()).toBe(20_000);
    // and the lag the operator is told about is the 48 h
    expect(r3.clock.lagMs).toBeGreaterThan(47.9 * H);
  });

  it('a jump of a year forward, run a day apart: asOf advances one day, not a year and not 72 h', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(DAY);
    m.jump(365 * DAY);
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(true);
    expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(DAY);
  });

  it('a clock that goes BACKWARD only makes the purge more cautious', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(DAY);
    m.jump(-3 * DAY);
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(false);
    expect(b.clock.asOf.getTime()).toBeLessThan(a.clock.asOf.getTime());
  });

  it('an application restart on the same boot keeps the measurement (the anchor is the machine, not the process)', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(2 * H);
    m.jump(30 * DAY); // jump while the application was restarting
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(true);
    expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(2 * H);
  });

  describe('after an outage whose length cannot be verified (another boot, another machine, no anchor)', () => {
    it('30 days passed for real: it advances at most RETENTION_MAX_CLOCK_ADVANCE_HOURS, flagged clockClamped', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(30 * DAY);
      m.reboot('boot-B');
      const b = runOn(m, a.stored);
      expect(b.clock.basis).toBe('unverified');
      expect(b.clock.clamped).toBe(true);
      expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(72 * H);
      expect(b.clock.lagMs).toBe(30 * DAY - 72 * H);
    });

    it('the second run after the reboot is verified again and does NOT take another 72 h: the lag stays', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(30 * DAY);
      m.reboot('boot-B');
      const b = runOn(m, a.stored);
      m.pass(DAY);
      const c = runOn(m, b.stored);
      expect(c.clock.basis).toBe('verified');
      expect(c.clock.clamped).toBe(true);
      expect(c.clock.asOf.getTime() - b.clock.asOf.getTime()).toBe(DAY);
    });

    it('a normal day between two boots (previous run 24 h ago on another machine) is not clamped', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(DAY);
      m.reboot('boot-B');
      const b = runOn(m, a.stored);
      expect(b.clock.clamped).toBe(false);
      expect(b.clock.basis).toBe('unverified');
    });

    it('a previous run without anchor (written before this release) is unverified, never trusted blindly', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      m.pass(10 * DAY);
      const prev: PreviousClock = {
        effectiveNow: T('2026-11-04T04:30:00Z'),
        bootId: null,
        uptimeMs: null,
      };
      const b = runOn(m, prev);
      expect(b.clock.clamped).toBe(true);
      expect(b.clock.asOf).toEqual(T('2026-11-07T04:30:00Z'));
    });

    it('an uptime that went DOWN on the same boot id is not trusted (counter wrapped or anchor corrupt)', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(DAY);
      m.uptimeMs = 10;
      expect(runOn(m, a.stored).clock.basis).toBe('unverified');
    });
  });

  describe('RETENTION_CLOCK_RESYNC: the operator says the outage was real', () => {
    it('adopts the database clock once, unflagged', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(30 * DAY);
      m.reboot('boot-B');
      const b = runOn(m, a.stored, { resync: true });
      expect(b.clock.basis).toBe('resync');
      expect(b.clock.clamped).toBe(false);
      expect(b.clock.asOf).toEqual(m.dbNow);
      expect(b.clock.lagMs).toBe(0);
    });

    it('does nothing when the clock was not capped anyway', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(DAY);
      expect(runOn(m, a.stored, { resync: true }).clock.basis).toBe('verified');
    });
  });

  it('the host source reads a boot id and a uptime that only moves forward', async () => {
    const a = hostMonotonicSource.anchor();
    await new Promise((r) => setTimeout(r, 30));
    const b = hostMonotonicSource.anchor();
    expect(b.bootId).toBe(a.bootId);
    if (a.bootId !== null) {
      expect(a.uptimeMs).not.toBeNull();
      expect(b.uptimeMs as number).toBeGreaterThanOrEqual(a.uptimeMs as number);
    }
  });

  it('marginalClock subtracts the fixed safety margin', () => {
    const d = T('2026-11-04T04:30:00Z');
    expect(marginalClock(d).getTime()).toBe(d.getTime() - SAFETY_MARGIN_MS);
  });
});
