import { effectiveClock, marginalClock } from './retention-clock.js';
import { SAFETY_MARGIN_MS } from './retention-config.js';

const T = (iso: string) => new Date(iso);

describe('retention clock (Story 20.8: a clock jump does not bring the purge forward)', () => {
  it('the first run has nothing to compare with: the database clock', () => {
    const r = effectiveClock(T('2026-11-04T04:30:00Z'), null, 72);
    expect(r).toEqual({ asOf: T('2026-11-04T04:30:00Z'), clamped: false });
  });

  it('a normal day after the previous run is used as is', () => {
    const r = effectiveClock(
      T('2026-11-05T04:30:00Z'),
      T('2026-11-04T04:30:00Z'),
      72,
    );
    expect(r.clamped).toBe(false);
    expect(r.asOf).toEqual(T('2026-11-05T04:30:00Z'));
  });

  it('a jump of a year forward is capped at previous + 72 h', () => {
    const r = effectiveClock(
      T('2027-11-04T04:30:00Z'),
      T('2026-11-04T04:30:00Z'),
      72,
    );
    expect(r.clamped).toBe(true);
    expect(r.asOf).toEqual(T('2026-11-07T04:30:00Z'));
  });

  it('exactly at the cap is not clamped; a millisecond past it is', () => {
    const prev = T('2026-11-04T00:00:00Z');
    expect(
      effectiveClock(T('2026-11-07T00:00:00.000Z'), prev, 72).clamped,
    ).toBe(false);
    expect(
      effectiveClock(T('2026-11-07T00:00:00.001Z'), prev, 72).clamped,
    ).toBe(true);
  });

  it('a clock that went BACK only makes the purge more cautious', () => {
    const r = effectiveClock(
      T('2026-10-01T00:00:00Z'),
      T('2026-11-04T00:00:00Z'),
      72,
    );
    expect(r.asOf).toEqual(T('2026-10-01T00:00:00Z'));
    expect(r.clamped).toBe(false);
  });

  it('every cut-off starts from the clock minus the safety margin', () => {
    const asOf = T('2026-11-04T04:30:00Z');
    expect(asOf.getTime() - marginalClock(asOf).getTime()).toBe(
      SAFETY_MARGIN_MS,
    );
    expect(SAFETY_MARGIN_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});
