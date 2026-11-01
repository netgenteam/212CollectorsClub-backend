import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FakeFxProvider } from './../src/fx/fake-fx.provider.js';
import { FxRefreshService } from './../src/fx/fx-refresh.service.js';
import { FX_PROVIDER } from './../src/fx/fx-provider.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';

const D0 = new Date('2026-10-30T12:00:00.000Z');
const D1 = new Date('2026-10-31T12:00:00.000Z');
const D2 = new Date('2026-11-01T06:00:00.000Z');

/**
 * Story 18.1 (AD-79): FxRefreshService against the real DB with the fake
 * provider (zero network). The real FX row/snapshots are snapshotted in
 * beforeAll and restored byte for byte in afterAll.
 */
describe('FX refresh (e2e, Story 18.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FxRefreshService;
  let fake: FakeFxProvider;
  let saved: FxState;
  let realRowText: string;

  const rowText = async () =>
    JSON.stringify(
      await prisma.$queryRaw`SELECT * FROM "Fx_Rate_Settings" ORDER BY "id"`,
    );
  const setting = () =>
    prisma.fxRateSetting.findUniqueOrThrow({ where: { id: 'default' } });
  const snaps = (source = 'BCV_USD') =>
    prisma.fxRateSnapshot.count({ where: { source: source as 'BCV_USD' } });

  const reset = async (source = 'BCV_USD') => {
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "vesPerUsd" = 100, "source" = ${source}::"FxRateSource",
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
    fake = app.get(FakeFxProvider);
    expect(app.get(FX_PROVIDER)).toBe(fake);
    saved = await snapshotFx(prisma);
    realRowText = await rowText();
  });

  afterAll(async () => {
    await restoreFx(prisma, saved);
    // Byte-for-byte identical real row after the suite.
    expect(await rowText()).toBe(realRowText);
    expect(await prisma.fxRateSnapshot.count()).toBe(saved.snapshots.length);
    await app.close();
  });

  beforeEach(() => reset());

  it('a valid reading persists the rate and one snapshot', async () => {
    fake.succeed(889.26, D0);
    const r = await fx.refresh();
    expect(r).toMatchObject({ status: 'UPDATED', rate: '889.2600' });
    const s = await setting();
    expect(s.vesPerUsd.toFixed(4)).toBe('889.2600');
    expect(s.providerUpdatedAt).toEqual(D0);
    expect(s.lastError).toBeNull();
    expect(s.rejectedReading).toBeNull();
    expect(await snaps()).toBe(1);
  });

  it('the same reading repeated does not duplicate the snapshot (no-op)', async () => {
    fake.succeed(889.26, D0);
    await fx.refresh();
    expect((await fx.refresh()).status).toBe('NOOP');
    expect((await fx.refresh()).status).toBe('NOOP');
    expect(await snaps()).toBe(1);
  });

  describe('bad readings leave the current rate untouched', () => {
    beforeEach(async () => {
      fake.succeed(100, D0);
      await fx.refresh();
    });

    const expectRejected = async (reason?: string) => {
      const s = await setting();
      expect(s.vesPerUsd.toFixed(4)).toBe('100.0000');
      expect(s.providerUpdatedAt).toEqual(D0);
      expect(s.lastError).toBeTruthy();
      expect(s.lastErrorAt).not.toBeNull();
      if (reason) {
        expect(s.rejectedReading).toMatchObject({ reason });
      }
      expect(await snaps()).toBe(1);
    };

    it('provider down', async () => {
      fake.fail('boom');
      expect(await fx.refresh()).toMatchObject({ status: 'FAILED' });
      await expectRejected();
      expect((await setting()).lastError).toBe('boom');
    });
    it('unexpected shape', async () => {
      fake.unexpectedShape();
      expect((await fx.refresh()).status).toBe('FAILED');
      await expectRejected();
    });
    it('NaN', async () => {
      fake.nan(D1);
      expect(await fx.refresh()).toMatchObject({
        status: 'REJECTED',
        reason: 'NOT_FINITE',
      });
      await expectRejected('NOT_FINITE');
    });
    it('zero', async () => {
      fake.zero(D1);
      expect(await fx.refresh()).toMatchObject({ reason: 'NOT_POSITIVE' });
      await expectRejected('NOT_POSITIVE');
    });
    it('variation above the threshold (+16 %)', async () => {
      fake.variation(100, 16, D1);
      expect(await fx.refresh()).toMatchObject({
        reason: 'VARIATION_EXCEEDED',
      });
      await expectRejected('VARIATION_EXCEEDED');
    });
    it('old date', async () => {
      fake.succeed(100, new Date(D0.getTime() - 3600_000));
      expect(await fx.refresh()).toMatchObject({ reason: 'DATE_REGRESSION' });
      await expectRejected('DATE_REGRESSION');
    });
    it('a later valid reading clears lastError / rejectedReading', async () => {
      fake.nan(D1);
      await fx.refresh();
      fake.succeed(105, D2);
      expect((await fx.refresh()).status).toBe('UPDATED');
      const s = await setting();
      expect(s.lastError).toBeNull();
      expect(s.rejectedReading).toBeNull();
      expect(s.vesPerUsd.toFixed(4)).toBe('105.0000');
      expect(await snaps()).toBe(2);
    });
  });

  it('5 concurrent refresh() => exactly 1 snapshot, no throws, rest IN_PROGRESS/NOOP', async () => {
    for (let round = 0; round < 5; round++) {
      await reset();
      fake.succeed(889.26, new Date(D0.getTime() + round * 1000));
      const results = await Promise.all(
        Array.from({ length: 5 }, () => fx.refresh()),
      );
      const updated = results.filter((r) => r.status === 'UPDATED');
      expect(updated.length).toBeLessThanOrEqual(1);
      expect(updated.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(['UPDATED', 'IN_PROGRESS', 'NOOP']).toContain(r.status);
      }
      expect(await snaps()).toBe(1);
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('889.2600');
    }
  });

  it('MANUAL never queries the provider', async () => {
    await prisma.$executeRaw`UPDATE "Fx_Rate_Settings" SET "source" = 'MANUAL', "manualVesPerUsd" = 50 WHERE "id" = 'default'`;
    fake.succeed(999, D0);
    expect((await fx.refresh()).status).toBe('MANUAL');
    expect(fake.calls).toHaveLength(0);
    expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
  });

  it('a source change does not compare against another source (AC6)', async () => {
    fake.succeed(100, D0);
    await fx.refresh();
    await prisma.$executeRaw`UPDATE "Fx_Rate_Settings" SET "source" = 'BCV_EUR' WHERE "id" = 'default'`;
    // 5x the USD rate and an older date: accepted, EUR has no history.
    fake.succeed(500, new Date(D0.getTime() - 86400_000));
    expect(await fx.refresh()).toMatchObject({
      status: 'UPDATED',
      source: 'BCV_EUR',
    });
    expect(fake.calls.at(-1)).toBe('BCV_EUR');
    expect(await snaps('BCV_EUR')).toBe(1);
    // ...but the next EUR reading IS compared with the EUR snapshot.
    fake.variation(500, 20, D2);
    expect(await fx.refresh()).toMatchObject({ status: 'REJECTED' });
  });

  it('refresh(source) for a non-active source is skipped', async () => {
    expect((await fx.refresh('PARALELO_USD')).status).toBe('SKIPPED');
    expect(fake.calls).toHaveLength(0);
  });

  describe('cron', () => {
    const prev = process.env.FX_REFRESH_ENABLED;
    afterAll(() => {
      if (prev === undefined) delete process.env.FX_REFRESH_ENABLED;
      else process.env.FX_REFRESH_ENABLED = prev;
    });

    it('respects FX_REFRESH_ENABLED and never throws', async () => {
      process.env.FX_REFRESH_ENABLED = 'false';
      await fx.handleCron();
      expect(fake.calls).toHaveLength(0);
      process.env.FX_REFRESH_ENABLED = 'true';
      await expect(fx.handleCron()).resolves.toBeUndefined();
      expect(fake.calls).toEqual(['BCV_USD']);
      fake.fail('down');
      await expect(fx.handleCron()).resolves.toBeUndefined();
    });

    it('purges snapshots older than 400 days only', async () => {
      const day = 86400_000;
      const mk = (i: number, ageDays: number) => ({
        source: 'BCV_USD' as const,
        rate: 1,
        providerUpdatedAt: new Date(D0.getTime() - i * day),
        fetchedAt: new Date(Date.now() - ageDays * day),
      });
      await prisma.fxRateSnapshot.createMany({
        data: [mk(1, 401), mk(2, 399), mk(3, 10)],
      });
      expect(await fx.purgeOldSnapshots()).toBe(1);
      expect(await snaps()).toBe(2);
    });
  });
});
