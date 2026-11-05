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
  opts: { maxAdvanceHours?: number } = {},
) {
  const clock = effectiveClock({
    dbNow: m.dbNow,
    previous,
    current: m.anchor(),
    maxAdvanceHours: opts.maxAdvanceHours ?? 72,
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
    m.jump(DAY + CLOCK_DRIFT_TOLERANCE_MS); // exactly at the limit (elapsed + recovery) plus the tolerance
    expect(runOn(m, a.stored).clock.clamped).toBe(false);
    m.jump(1);
    expect(runOn(m, a.stored).clock.clamped).toBe(true);
  });

  it('REPRODUCTION of the round-2 finding: a +48 h jump and three POSTs in a row advance asOf by 2x the real seconds, not +3/+6/+9 days', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const first = runOn(m, null);
    m.pass(10_000);
    m.jump(48 * H); // the machine clock jumped 48 h forward
    const r1 = runOn(m, first.stored);
    expect(r1.clock.clamped).toBe(true);
    // the real time since the previous run is 10 s: asOf moved by 10 s + 10 s of recovery, not by 48 h
    expect(r1.clock.asOf.getTime() - first.clock.asOf.getTime()).toBe(20_000);
    m.pass(5_000);
    const r2 = runOn(m, r1.stored);
    m.pass(5_000);
    const r3 = runOn(m, r2.stored);
    expect(r2.clock.asOf.getTime() - r1.clock.asOf.getTime()).toBe(10_000);
    expect(r3.clock.asOf.getTime() - r2.clock.asOf.getTime()).toBe(10_000);
    expect(r3.clock.clamped).toBe(true);
    expect(r3.clock.asOf.getTime() - first.clock.asOf.getTime()).toBe(40_000);
    expect(r3.clock.lagMs).toBeGreaterThan(47.9 * H);
  });

  it('twenty runs inside one minute do not accelerate: the advance is 2x the real seconds, whatever the number of runs', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const first = runOn(m, null);
    m.jump(10 * DAY);
    let prev = first;
    for (let k = 0; k < 20; k++) {
      m.pass(3_000);
      prev = runOn(m, prev.stored);
    }
    expect(prev.clock.asOf.getTime() - first.clock.asOf.getTime()).toBe(
      2 * 60_000,
    );
  });

  it('a jump of a year forward, run a day apart: asOf advances two days, not a year', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(DAY);
    m.jump(365 * DAY);
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(true);
    expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(2 * DAY);
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

  it('a previous effectiveNow in the FUTURE of the database clock does not get the run stuck', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    // an earlier run stored an effectiveNow 10 days ahead (the clock was wrong then and has been set right)
    const future: PreviousClock = {
      effectiveNow: new Date(m.dbNow.getTime() + 10 * DAY),
      ...m.anchor(),
    };
    m.pass(DAY);
    const b = runOn(m, future);
    expect(b.clock.clamped).toBe(false);
    expect(b.clock.asOf).toEqual(m.dbNow); // adopted the database clock: the cut-off went BACK, never forward
    m.pass(DAY);
    const c = runOn(m, b.stored);
    expect(c.clock.asOf).toEqual(m.dbNow);
    expect(c.clock.asOf.getTime() - b.clock.asOf.getTime()).toBe(DAY);
  });

  it('an application restart on the same boot keeps the measurement (the anchor is the machine, not the process)', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(2 * H);
    m.jump(30 * DAY); // jump while the application was restarting
    const b = runOn(m, a.stored);
    expect(b.clock.clamped).toBe(true);
    expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(4 * H);
  });

  /**
   * Daily runs (04:30) until the lag is closed. Returns how many days it took and the lag after each run.
   * `rebootedMsBeforeFirstRun` is the uptime when the first run after the outage happens.
   */
  function catchUp(
    outageMs: number,
    rebootedMsBeforeFirstRun = 30 * 60_000,
  ): { days: number; lags: number[]; first: ReturnType<typeof runOn> } {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(outageMs); // the machine was off (the wall clock moved, the uptime counter restarted)
    m.reboot('boot-B');
    m.uptimeMs = rebootedMsBeforeFirstRun;
    const first = runOn(m, a.stored);
    const lags = [first.clock.lagMs];
    let prev = first;
    let days = 0;
    while (prev.clock.lagMs > 0 && days < 400) {
      m.pass(DAY);
      prev = runOn(m, prev.stored);
      lags.push(prev.clock.lagMs);
      days++;
    }
    return { days, lags, first };
  }

  describe('recovery after an outage (the machine was off, then rebooted: the elapsed time cannot be verified)', () => {
    it('5 days off: the first run credits only the uptime, then it catches up in about 5 days (not never)', () => {
      const r = catchUp(5 * DAY);
      expect(r.first.clock.basis).toBe('unverified');
      expect(r.first.clock.clamped).toBe(true);
      // 30 min of uptime credited twice: asOf moved 1 h, NOT 72 h
      expect(r.first.clock.asOf.getTime()).toBe(
        T('2026-11-04T04:30:00Z').getTime() + H,
      );
      expect(r.first.clock.lagMs).toBe(5 * DAY - H);
      expect(r.days).toBeGreaterThanOrEqual(4);
      expect(r.days).toBeLessThanOrEqual(5);
      // the lag shrinks by 24 h per day of real time (the extra half of the 2x)
      expect(r.lags[1]).toBe(r.lags[0] - DAY);
    });

    it('30 days off: it catches up in about 30 days, which stays long and visible', () => {
      const r = catchUp(30 * DAY);
      expect(r.days).toBeGreaterThanOrEqual(29);
      expect(r.days).toBeLessThanOrEqual(30);
      expect(r.first.clock.clamped).toBe(true);
    });

    it('a lag of 72 h (what the round-2 cap left behind for good) closes in 3 days', () => {
      const r = catchUp(72 * H + H);
      expect(r.days).toBeLessThanOrEqual(3);
    });

    it('the credit of an unverifiable boot is capped (the previous run may come from another machine with a long uptime)', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(400 * DAY);
      m.reboot('machine-with-400-days-of-uptime');
      m.uptimeMs = 400 * DAY;
      const b = runOn(m, a.stored);
      // 72 h of credit + 72 h of recovery at the very most, never the 400 days
      expect(b.clock.asOf.getTime() - a.clock.asOf.getTime()).toBe(144 * H);
      expect(b.clock.clamped).toBe(true);
    });

    it('QA reproduction: restart 12 h after a run with the clock 60 h ahead does NOT purge 60 h early', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(12 * H);
      m.jump(60 * H);
      m.reboot('boot-B');
      m.uptimeMs = 5 * 60_000; // 5 minutes after the boot
      const b = runOn(m, a.stored);
      const realNow = a.clock.asOf.getTime() + 12 * H; // where asOf would be on a clock that never jumped
      expect(b.clock.clamped).toBe(true);
      // the first version left asOf 60 h ahead of real time; now it is at most the credited uptime ahead (minutes)
      expect(b.clock.asOf.getTime() - realNow).toBeLessThan(0);
      expect(b.clock.asOf.getTime()).toBe(a.clock.asOf.getTime() + 10 * 60_000);
    });

    it('a normal day between two boots (previous run 24 h ago on another machine) is a lag of a day that closes in a day', () => {
      const r = catchUp(DAY);
      expect(r.days).toBeLessThanOrEqual(1);
    });

    it('a previous run without anchor (written before this release) is unverified, never trusted blindly', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      m.pass(10 * DAY);
      m.uptimeMs = 2 * H;
      const prev: PreviousClock = {
        effectiveNow: T('2026-11-04T04:30:00Z'),
        bootId: null,
        uptimeMs: null,
      };
      const b = runOn(m, prev);
      expect(b.clock.clamped).toBe(true);
      expect(b.clock.basis).toBe('unverified');
      expect(b.clock.asOf).toEqual(T('2026-11-04T08:30:00Z'));
    });

    it('an uptime that went DOWN on the same boot id is not trusted (counter wrapped or anchor corrupt)', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(DAY);
      m.uptimeMs = 10;
      expect(runOn(m, a.stored).clock.basis).toBe('unverified');
    });

    it('a current reading with no anchor at all credits nothing (it only waits)', () => {
      const m = new Machine('2026-11-04T04:30:00Z');
      const a = runOn(m, null);
      m.pass(5 * DAY);
      const b = effectiveClock({
        dbNow: m.dbNow,
        previous: a.stored,
        current: { bootId: null, uptimeMs: null },
        maxAdvanceHours: 72,
      });
      expect(b.asOf).toEqual(a.clock.asOf);
      expect(b.clamped).toBe(true);
    });
  });

  it('a container restart (same host boot) keeps measuring: an outage of the container with the host up is verified', () => {
    const m = new Machine('2026-11-04T04:30:00Z');
    const a = runOn(m, null);
    m.pass(5 * DAY); // the container was stopped for 5 days; the host kept running
    const b = runOn(m, a.stored);
    expect(b.clock.basis).toBe('verified');
    expect(b.clock.clamped).toBe(false); // 5 days really passed: dbNow is adopted straight away
    expect(b.clock.asOf).toEqual(m.dbNow);
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
