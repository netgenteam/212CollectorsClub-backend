import {
  checkDatabaseClock,
  readDatabaseClockCheck,
} from './db-clock-check.js';

const db = (
  n: Date,
  e: number,
  z = 'UTC',
): Parameters<typeof checkDatabaseClock>[0] =>
  ({
    $queryRawUnsafe: () => Promise.resolve([{ n, e: BigInt(e), z }]),
  }) as never;
const logger = () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn() });

describe('boot check of the database clock (Story 20.8 round 2)', () => {
  const t = Date.UTC(2026, 10, 5, 6, 0, 0, 0);

  it('a driver that reads the instant right: ok, silent', async () => {
    const l = logger();
    const c = await checkDatabaseClock(db(new Date(t), t), l);
    expect(c).toMatchObject({ ok: true, parseErrorMs: 0, sessionZone: 'UTC' });
    expect(l.error).not.toHaveBeenCalled();
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('REPRODUCTION: now() parsed 18 000 s early (a New York session read through the adapter) is an ERROR that names the cause and the docs', async () => {
    const l = logger();
    const c = await checkDatabaseClock(
      db(new Date(t - 18_000_000), t, 'America/New_York'),
      l,
    );
    expect(c?.ok).toBe(false);
    expect(c?.parseErrorMs).toBe(-18_000_000);
    const msg = String(l.error.mock.calls[0][0]);
    expect(msg).toMatch(/18000 s/);
    expect(msg).toMatch(/TimeZone=UTC/);
    expect(msg).toMatch(/docs\/deployment\.md section 21/);
  });

  it('a non-UTC session that is read right is a WARN, not an error', async () => {
    const l = logger();
    await checkDatabaseClock(db(new Date(t), t, 'Asia/Tokyo'), l);
    expect(l.error).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledTimes(1);
  });

  it('a database that does not answer never blocks the boot', async () => {
    const l = logger();
    const c = await checkDatabaseClock(
      { $queryRawUnsafe: () => Promise.reject(new Error('down')) },
      l,
    );
    expect(c).toBeNull();
    expect(l.warn).toHaveBeenCalled();
  });

  it('half a second of difference is rounding, not a misread', async () => {
    expect((await readDatabaseClockCheck(db(new Date(t + 400), t))).ok).toBe(
      true,
    );
    expect((await readDatabaseClockCheck(db(new Date(t + 1_500), t))).ok).toBe(
      false,
    );
  });
});
