import { evaluateReading, isSameReading } from './fx-validation.js';

const now = new Date('2026-11-01T12:00:00Z');
const t = (min: number) => new Date(now.getTime() + min * 60_000);
const cur = { rate: 100, providerUpdatedAt: t(-60) };
const ev = (rate: number, at = t(-10), current: typeof cur | null = cur) =>
  evaluateReading({
    reading: { rate, providerUpdatedAt: at },
    current,
    maxVariationPct: 15,
    now,
  });

describe('evaluateReading (Story 18.1)', () => {
  it('rejects NaN / Infinity as NOT_FINITE', () => {
    expect(ev(NaN)).toEqual({ ok: false, reason: 'NOT_FINITE' });
    expect(ev(Infinity)).toEqual({ ok: false, reason: 'NOT_FINITE' });
    expect(ev(-Infinity)).toEqual({ ok: false, reason: 'NOT_FINITE' });
  });
  it('rejects 0 and negatives as NOT_POSITIVE', () => {
    expect(ev(0)).toEqual({ ok: false, reason: 'NOT_POSITIVE' });
    expect(ev(-5)).toEqual({ ok: false, reason: 'NOT_POSITIVE' });
  });
  it('accepts 14.9 % and rejects 15.1 % variation (both directions)', () => {
    expect(ev(114.9)).toEqual({ ok: true });
    expect(ev(85.1)).toEqual({ ok: true });
    expect(ev(115.1)).toEqual({ ok: false, reason: 'VARIATION_EXCEEDED' });
    expect(ev(84.9)).toEqual({ ok: false, reason: 'VARIATION_EXCEEDED' });
  });
  it('rejects a date older than the current one', () => {
    expect(ev(100, t(-61))).toEqual({ ok: false, reason: 'DATE_REGRESSION' });
  });
  it('rejects a date more than 5 min in the future, accepts exactly 5 min', () => {
    expect(ev(100, t(5.1))).toEqual({ ok: false, reason: 'FUTURE_DATE' });
    expect(ev(100, t(5))).toEqual({ ok: true });
  });
  it('accepts equal date with same rate (caller treats it as no-op)', () => {
    expect(ev(100, cur.providerUpdatedAt)).toEqual({ ok: true });
    expect(
      isSameReading(
        { rate: 100, providerUpdatedAt: cur.providerUpdatedAt },
        cur,
      ),
    ).toBe(true);
    expect(
      isSameReading(
        { rate: 101, providerUpdatedAt: cur.providerUpdatedAt },
        cur,
      ),
    ).toBe(false);
    expect(isSameReading({ rate: 100, providerUpdatedAt: t(-5) }, cur)).toBe(
      false,
    );
  });
  it('accepts anything valid when there is nothing to compare with', () => {
    expect(ev(5000, t(-1), null)).toEqual({ ok: true });
  });
});
