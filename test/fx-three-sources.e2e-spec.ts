import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  FAKE_FX_FIXTURES,
  FakeFxProvider,
} from './../src/fx/fake-fx.provider.js';
import { FxRefreshService } from './../src/fx/fx-refresh.service.js';
import { AdminFxService } from './../src/fx/admin-fx.service.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';
import { blockAuditAction } from './helpers/block-audit-action.js';

const DAY = 86_400_000;
const D0 = new Date(Date.now() - 3 * DAY);
const D1 = new Date(Date.now() - 2 * DAY);
const SOURCES = ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const;

/** Story 22.2 (AD-110): three sources per cycle + Fx_Source_States, real DB and fake provider. */
describe('FX three sources per cycle (e2e, Story 22.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FxRefreshService;
  let admin: AdminFxService;
  let fake: FakeFxProvider;
  let saved: FxState;

  const setting = () =>
    prisma.fxRateSetting.findUniqueOrThrow({ where: { id: 'default' } });
  const state = (source: (typeof SOURCES)[number]) =>
    prisma.fxSourceState.findUnique({ where: { source } });
  const snaps = (source: (typeof SOURCES)[number]) =>
    prisma.fxRateSnapshot.count({ where: { source } });
  const events = () =>
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Audit_Events" WHERE "action" = 'FX_RATE_CHANGED'`.then(
      (r) => Number(r[0].n),
    );
  const reset = async (source = 'BCV_USD') => {
    await prisma.fxSourceState.deleteMany();
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "vesPerUsd" = 200, "source" = ${source}::"FxRateSource",
        "manualVesPerUsd" = NULL, "maxVariationPct" = 15, "maxAgeHours" = 48,
        "rateFetchedAt" = now(), "providerUpdatedAt" = NULL, "lastError" = NULL,
        "lastErrorAt" = NULL, "rejectedReading" = NULL WHERE "id" = 'default'`;
    fake.reset();
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    fx = app.get(FxRefreshService);
    admin = app.get(AdminFxService);
    fake = app.get(FakeFxProvider);
    saved = await snapshotFx(prisma);
  });
  afterAll(async () => {
    await restoreFx(prisma, saved);
    await app.close();
  });
  beforeEach(() => reset());

  it('AC2/AC7: one cycle reads the 3 sources; only the active one moves the rate; status shows 3 sources + sourceStates', async () => {
    fake.succeedFor('BCV_USD', 922.1, D0);
    fake.succeedFor('BCV_EUR', 1012.2, D0);
    fake.succeedFor('PARALELO_USD', 1103.3, D0);
    const before = await events();
    const r = await fx.refresh();
    expect(r).toMatchObject({ status: 'UPDATED', source: 'BCV_USD' });
    expect([...fake.calls].sort()).toEqual([...SOURCES].sort());
    expect((await setting()).vesPerUsd.toFixed(4)).toBe('922.1000');
    expect(await events()).toBe(before + 1); // only the active one emits
    for (const s of SOURCES) expect(await snaps(s)).toBe(1);

    const st = await admin.getStatus();
    expect(st.sources.BCV_USD?.rate).toBe('922.1000');
    expect(st.sources.BCV_EUR?.rate).toBe('1012.2000');
    expect(st.sources.PARALELO_USD?.rate).toBe('1103.3000');
    expect(st.sources.BCV_EUR?.providerUpdatedAt).toBe(D0.toISOString());
    expect(Object.keys(st.sourceStates).sort()).toEqual([...SOURCES].sort());
    for (const s of SOURCES) {
      expect(st.sourceStates[s].lastSuccessAt).not.toBeNull();
      expect(st.sourceStates[s].lastError).toBeNull();
      expect(st.sourceStates[s].rejectedReading).toBeNull();
    }
  });

  it('AC7: with no rows, sourceStates still has the 3 keys with every field null; sources null', async () => {
    const st = await admin.getStatus();
    for (const s of SOURCES) {
      expect(st.sources[s]).toBeNull();
      expect(st.sourceStates[s]).toEqual({
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastErrorAt: null,
        rejectedReading: null,
      });
    }
  });

  it('AC7: status costs two table reads (no N+1)', async () => {
    await fx.refresh();
    const states = vi.spyOn(prisma.fxSourceState, 'findMany');
    const first = vi.spyOn(prisma.fxRateSnapshot, 'findFirst');
    const raw = vi.spyOn(prisma, '$queryRaw');
    await admin.getStatus();
    expect(states).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('AC8: the previous status JSON is a subset of the new one', async () => {
    await fx.refresh();
    const st = JSON.parse(JSON.stringify(await admin.getStatus())) as Record<
      string,
      unknown
    >;
    const previousKeys = [
      'source',
      'rate',
      'providerUpdatedAt',
      'fetchedAt',
      'stale',
      'hardStale',
      'lastError',
      'rejectedReading',
      'sources',
    ];
    for (const k of previousKeys) expect(st).toHaveProperty(k);
    expect(Object.keys(st.sources as object).sort()).toEqual(
      [...SOURCES].sort(),
    );
    expect(
      Object.keys((st.sources as Record<string, object>).BCV_USD).sort(),
    ).toEqual(['fetchedAt', 'providerUpdatedAt', 'rate']);
  });

  it('AC6: BCV_EUR answers 500 => the other two are recorded, BCV_EUR keeps lastError', async () => {
    fake.failFor('BCV_EUR', 'HTTP 500');
    const r = await fx.refresh();
    expect(r.status).toBe('UPDATED');
    expect(await snaps('BCV_USD')).toBe(1);
    expect(await snaps('PARALELO_USD')).toBe(1);
    expect(await snaps('BCV_EUR')).toBe(0);
    const eur = await state('BCV_EUR');
    expect(eur?.lastError).toBe('HTTP 500');
    expect(eur?.lastErrorAt).not.toBeNull();
    expect(eur?.lastSuccessAt).toBeNull();
    expect(eur?.lastAttemptAt).not.toBeNull();
    expect((await state('BCV_USD'))?.lastError).toBeNull();
    // sources[BCV_EUR] stays null (never a valid reading), the error travels in sourceStates
    const st = await admin.getStatus();
    expect(st.sources.BCV_EUR).toBeNull();
    expect(st.sourceStates.BCV_EUR.lastError).toBe('HTTP 500');
    // recovery clears the error and keeps lastSuccessAt
    fake.reset();
    await fx.refresh();
    const ok = await state('BCV_EUR');
    expect(ok?.lastError).toBeNull();
    expect(ok?.lastSuccessAt).not.toBeNull();
  });

  it('AC6: the ACTIVE source failing does not stop the inactive ones', async () => {
    fake.failFor('BCV_USD', 'down');
    expect(await fx.refresh()).toMatchObject({ status: 'FAILED' });
    expect(await snaps('BCV_EUR')).toBe(1);
    expect((await state('BCV_USD'))?.lastError).toBe('down');
    expect((await setting()).vesPerUsd.toFixed(4)).toBe('200.0000');
  });

  it('AC6: a 503 of the audit log in phase A does not block phase B', async () => {
    const r = await blockAuditAction('FX_RATE_CHANGED', () => fx.refresh());
    expect(r).toMatchObject({ status: 'FAILED', source: 'BCV_USD' });
    expect(await snaps('BCV_USD')).toBe(0);
    expect(await snaps('BCV_EUR')).toBe(1);
    expect(await snaps('PARALELO_USD')).toBe(1);
    expect((await state('BCV_USD'))?.lastError).toMatch(/audit log/);
  });

  it('AC4: an inactive source out of range is rejected, never moves the rate and never emits', async () => {
    await prisma.fxRateSnapshot.create({
      data: { source: 'BCV_EUR', rate: '1000.0000', providerUpdatedAt: D0 },
    });
    fake.succeedFor('BCV_EUR', 5100.5, D1); // +410 %
    const before = await events();
    await fx.refresh();
    const eur = await state('BCV_EUR');
    expect(eur?.lastError).toBe('Reading rejected: VARIATION_EXCEEDED');
    expect(eur?.rejectedReading).toMatchObject({
      source: 'BCV_EUR',
      rate: 5100.5,
      reason: 'VARIATION_EXCEEDED',
    });
    expect(await snaps('BCV_EUR')).toBe(1);
    expect((await setting()).vesPerUsd.toFixed(4)).toBe(
      FAKE_FX_FIXTURES.BCV_USD.toFixed(4),
    );
    expect(await events()).toBe(before + 1); // the active BCV_USD only
    // singleton contract: the active source's error fields are untouched by the inactive one
    expect((await setting()).rejectedReading).toBeNull();
  });

  it('AC4 (QA 22.1): inactive phase B keeps DATE_NOT_NEWER for the same date with another rate, even when the snapshot is not a current reference', async () => {
    const old = new Date(Date.now() - 30 * DAY);
    await prisma.fxRateSnapshot.create({
      data: {
        source: 'PARALELO_USD',
        rate: '900.0000',
        providerUpdatedAt: old,
      },
    });
    fake.succeedFor('PARALELO_USD', 950, old);
    await fx.refresh();
    expect((await state('PARALELO_USD'))?.lastError).toBe(
      'Reading rejected: DATE_NOT_NEWER',
    );
    expect(await snaps('PARALELO_USD')).toBe(1);
  });

  it('AC4/22.1: residual 5100.5 (30 d) on an inactive source does not block a real reading', async () => {
    await prisma.fxRateSnapshot.create({
      data: {
        source: 'BCV_EUR',
        rate: '5100.5000',
        providerUpdatedAt: new Date(Date.now() - 30 * DAY),
      },
    });
    fake.succeedFor('BCV_EUR', 1012, D0);
    await fx.refresh();
    expect(await snaps('BCV_EUR')).toBe(2);
    expect((await state('BCV_EUR'))?.lastError).toBeNull();
  });

  it('AC4/22.1: an inactive source confirms a rejected reading with a newer date (candidate from Fx_Source_States)', async () => {
    await prisma.fxRateSnapshot.create({
      data: { source: 'BCV_EUR', rate: '1000.0000', providerUpdatedAt: D0 },
    });
    fake.succeedFor('BCV_EUR', 1300, D1);
    await fx.refresh();
    expect((await state('BCV_EUR'))?.lastError).toMatch(/VARIATION_EXCEEDED/);
    fake.succeedFor('BCV_EUR', 1301, new Date(Date.now() - DAY));
    await fx.refresh();
    const eur = await state('BCV_EUR');
    expect(eur?.lastError).toBeNull();
    expect(eur?.rejectedReading).toBeNull();
    expect(await snaps('BCV_EUR')).toBe(2);
  });

  it('AC3: MANUAL active => {status: MANUAL}, the manual rate stays, the 3 sources are still recorded', async () => {
    await reset('MANUAL');
    const r = await fx.refresh();
    expect(r).toEqual({ status: 'MANUAL' });
    expect((await setting()).vesPerUsd.toFixed(4)).toBe('200.0000');
    for (const s of SOURCES) {
      expect(await snaps(s)).toBe(1);
      expect((await state(s))?.lastSuccessAt).not.toBeNull();
    }
  });

  it("AC2: scope 'active' reads only the active source; refresh(non-active) is SKIPPED without network", async () => {
    await fx.refresh(undefined, { scope: 'active' });
    expect(fake.calls).toEqual(['BCV_USD']);
    expect(await state('BCV_EUR')).toBeNull();
    fake.calls = [];
    expect((await fx.refresh('BCV_EUR')).status).toBe('SKIPPED');
    expect(fake.calls).toEqual([]);
  });

  it('AC5: phase A writes its own state row; the candidate falls back to the singleton when there is no row', async () => {
    await prisma.fxRateSnapshot.create({
      data: { source: 'BCV_USD', rate: '1000.0000', providerUpdatedAt: D0 },
    });
    await prisma.fxRateSetting.update({
      where: { id: 'default' },
      data: {
        vesPerUsd: '1000',
        rejectedReading: {
          source: 'BCV_USD',
          rate: 1300,
          rawRate: '1300',
          providerUpdatedAt: D1.toISOString(),
          reason: 'VARIATION_EXCEEDED',
          at: new Date().toISOString(),
        },
      },
    });
    expect(await state('BCV_USD')).toBeNull();
    fake.succeedFor('BCV_USD', 1301, new Date(Date.now() - DAY));
    expect(await fx.refresh()).toMatchObject({ status: 'UPDATED' });
    expect((await setting()).vesPerUsd.toFixed(4)).toBe('1301.0000');
    expect((await state('BCV_USD'))?.lastSuccessAt).not.toBeNull();
  });

  it('AC9: two cycles with the same reading => one snapshot per (source, providerUpdatedAt), lastAttemptAt advances', async () => {
    await fx.refresh();
    const a = (await state('BCV_EUR'))?.lastAttemptAt as Date;
    await new Promise((r) => setTimeout(r, 15));
    await fx.refresh();
    const b = (await state('BCV_EUR'))?.lastAttemptAt as Date;
    expect(b.getTime()).toBeGreaterThan(a.getTime());
    for (const s of SOURCES) expect(await snaps(s)).toBe(1);
  });

  it('AC9: simultaneous cycles => no deadlock and a single rate event', async () => {
    const before = await events();
    const rs = await Promise.all([fx.refresh(), fx.refresh(), fx.refresh()]);
    expect(
      rs.every((r) => ['UPDATED', 'NOOP', 'IN_PROGRESS'].includes(r.status)),
    ).toBe(true);
    expect(await events()).toBe(before + 1);
    for (const s of SOURCES) expect(await snaps(s)).toBe(1);
  });

  it('AC9: a source that became active before phase B is skipped by phase B', async () => {
    const phaseB = (
      fx as unknown as {
        refreshInactive: (
          s: string[],
          r: Map<string, unknown>,
        ) => Promise<void>;
      }
    ).refreshInactive.bind(fx);
    // active at the start was BCV_USD; by the time B holds the lock BCV_EUR is the active one.
    await prisma.fxRateSetting.update({
      where: { id: 'default' },
      data: { source: 'BCV_EUR' },
    });
    const reading = {
      ok: true,
      reading: { rate: 1000, providerUpdatedAt: D0 },
    };
    await phaseB(
      ['BCV_EUR', 'PARALELO_USD'],
      new Map([
        ['BCV_EUR', reading],
        ['PARALELO_USD', reading],
      ]),
    );
    expect(await snaps('BCV_EUR')).toBe(0);
    expect(await state('BCV_EUR')).toBeNull();
    expect(await snaps('PARALELO_USD')).toBe(1);
  });
});
