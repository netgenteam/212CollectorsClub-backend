import {
  decideReading,
  evaluateReading,
  isSameReading,
  selectReference,
} from './fx-validation.js';

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

  it('accepts EXACTLY +/-15 % with exact decimal arithmetic (QA 18.1 #1)', () => {
    const c = { rate: 20.2, providerUpdatedAt: t(-60) };
    expect(ev(23.23, t(-10), c)).toEqual({ ok: true });
    expect(ev(17.17, t(-10), c)).toEqual({ ok: true });
    expect(ev(23.2301, t(-10), c)).toEqual({
      ok: false,
      reason: 'VARIATION_EXCEEDED',
    });
    // Sweep: every cur with a +/-15 % exact result must be accepted.
    for (let cents = 1001; cents < 5000; cents += 37) {
      const cur0 = cents / 100;
      const upper = Number((cur0 * 1.15).toFixed(4));
      const exact = Math.round(cur0 * 115) / 100;
      if (Math.abs(upper - exact) > 1e-9) continue;
      expect(
        ev(exact, t(-10), { rate: cur0, providerUpdatedAt: t(-60) }),
      ).toEqual({ ok: true });
    }
  });
  it('rejects readings outside Decimal(18,4) as OUT_OF_RANGE (QA 18.1 #2)', () => {
    expect(ev(1e20, t(-10), null)).toEqual({
      ok: false,
      reason: 'OUT_OF_RANGE',
    });
    expect(ev(1e14, t(-10), null)).toEqual({
      ok: false,
      reason: 'OUT_OF_RANGE',
    });
    expect(ev(99999999999999.9, t(-10), null)).toEqual({ ok: true });
    expect(ev(0.00001, t(-10), null)).toEqual({
      ok: false,
      reason: 'NOT_POSITIVE',
    });
  });
  it('rejects the same date with a different rate as DATE_NOT_NEWER (QA 18.1 #3)', () => {
    expect(ev(101, cur.providerUpdatedAt)).toEqual({
      ok: false,
      reason: 'DATE_NOT_NEWER',
    });
    expect(ev(100.00004, cur.providerUpdatedAt)).toEqual({ ok: true });
  });
});

describe('selectReference (Story 22.1, AC1)', () => {
  const H = 3600_000;
  const snap = (ms: number | null) => ({
    rate: 100,
    providerUpdatedAt: ms === null ? null : new Date(now.getTime() + ms),
  });
  it.each([
    ['exact 96 h edge is current', -96 * H, true],
    ['96 h + 1 ms is not', -96 * H - 1, false],
    ['now', 0, true],
    ['+5 min future is current', 5 * 60_000, true],
    ['+6 min future is null', 6 * 60_000, false],
    ['24 days old is null', -24 * 24 * H, false],
  ])('%s', (_n, ms, ok) => {
    const s = snap(ms);
    expect(selectReference(s, now, 96)).toBe(ok ? s : null);
  });
  it('no snapshot => null', () => {
    expect(selectReference(null, now, 96)).toBeNull();
    expect(selectReference(snap(null), now, 96)).toBeNull();
  });
});

describe('decideReading (Story 22.1, AC2-3)', () => {
  const H = 3600_000;
  const ref = { rate: 100, providerUpdatedAt: t(-60) };
  const cand = (
    over: Partial<{ rate: number; at: Date; pu: Date; reason: string }> = {},
  ) => ({
    rate: over.rate ?? 200,
    providerUpdatedAt: over.pu ?? t(-30),
    reason: over.reason ?? 'VARIATION_EXCEEDED',
    at: over.at ?? t(-20),
  });
  const dec = (
    rate: number,
    o: Partial<Parameters<typeof decideReading>[0]> & { at?: Date } = {},
  ) =>
    decideReading({
      reading: { rate, providerUpdatedAt: o.at ?? t(-10) },
      reference: 'reference' in o ? o.reference! : ref,
      candidate: o.candidate ?? null,
      maxVariationPct: 15,
      now,
      collision: o.collision,
    });

  it('no reference => ACCEPT(NO_REFERENCE) even for a huge variation', () => {
    expect(dec(5000, { reference: null })).toEqual({
      accept: true,
      via: 'NO_REFERENCE',
    });
  });
  it('within limit => WITHIN_LIMIT', () => {
    expect(dec(110)).toEqual({ accept: true, via: 'WITHIN_LIMIT' });
  });
  it('isolated variation without candidate => REJECT VARIATION_EXCEEDED', () => {
    expect(dec(200)).toEqual({ accept: false, reason: 'VARIATION_EXCEEDED' });
  });
  it('date regression / not newer against the reference', () => {
    expect(dec(100, { at: t(-120) })).toEqual({
      accept: false,
      reason: 'DATE_REGRESSION',
    });
    expect(dec(101, { at: t(-60) })).toEqual({
      accept: false,
      reason: 'DATE_NOT_NEWER',
    });
  });
  it('confirmation: +0.5 % exact confirms, +0.51 % rejects', () => {
    expect(dec(201, { candidate: cand() })).toEqual({
      accept: true,
      via: 'CONFIRMED',
    });
    expect(dec(199, { candidate: cand() })).toEqual({
      accept: true,
      via: 'CONFIRMED',
    });
    expect(dec(201.02, { candidate: cand() })).toEqual({
      accept: false,
      reason: 'VARIATION_EXCEEDED',
    });
  });
  it('same providerUpdatedAt as the candidate does not confirm', () => {
    expect(dec(200, { candidate: cand({ pu: t(-10) }) })).toEqual({
      accept: false,
      reason: 'VARIATION_EXCEEDED',
    });
  });
  it('candidate 97 h old rejects; 96 h confirms', () => {
    expect(
      dec(200, { candidate: cand({ at: new Date(now.getTime() - 97 * H) }) }),
    ).toEqual({ accept: false, reason: 'VARIATION_EXCEEDED' });
    expect(
      dec(200, { candidate: cand({ at: new Date(now.getTime() - 96 * H) }) }),
    ).toEqual({ accept: true, via: 'CONFIRMED' });
  });
  it('candidate with another reason does not confirm', () => {
    expect(
      dec(200, { candidate: cand({ reason: 'DATE_REGRESSION' }) }),
    ).toEqual({ accept: false, reason: 'VARIATION_EXCEEDED' });
  });
  it('exact key collision with another rate => DATE_NOT_NEWER, even with no reference', () => {
    expect(
      dec(150, {
        reference: null,
        collision: { rate: 100, providerUpdatedAt: t(-10) },
      }),
    ).toEqual({ accept: false, reason: 'DATE_NOT_NEWER' });
  });
  it('structural failures always reject, even with a matching candidate / no reference', () => {
    const c = cand({ rate: 0 });
    expect(dec(0, { candidate: c })).toEqual({
      accept: false,
      reason: 'NOT_POSITIVE',
    });
    expect(dec(NaN, { reference: null })).toEqual({
      accept: false,
      reason: 'NOT_FINITE',
    });
    expect(dec(200, { candidate: cand(), at: t(6) })).toEqual({
      accept: false,
      reason: 'FUTURE_DATE',
    });
    expect(dec(1e15, { reference: null })).toEqual({
      accept: false,
      reason: 'OUT_OF_RANGE',
    });
  });
});
