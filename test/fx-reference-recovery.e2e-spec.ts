import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FakeFxProvider } from './../src/fx/fake-fx.provider.js';
import { FxRefreshService } from './../src/fx/fx-refresh.service.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H);

/** Story 22.1 (AD-109): current reference + confirmation, against the real DB and the fake provider. */
describe('FX reference recovery and confirmation (e2e, Story 22.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FxRefreshService;
  let fake: FakeFxProvider;
  let saved: FxState;

  const setting = () =>
    prisma.fxRateSetting.findUniqueOrThrow({ where: { id: 'default' } });
  const events = () =>
    prisma.$queryRaw<{ after: Record<string, unknown> }[]>`
      SELECT "after" FROM "Audit_Events" WHERE "action" = 'FX_RATE_CHANGED' ORDER BY "seq" DESC LIMIT 5`;
  const reset = async () => {
    await prisma.fxSourceState.deleteMany();
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "vesPerUsd" = 200, "source" = 'BCV_USD'::"FxRateSource",
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
    saved = await snapshotFx(prisma);
  });
  afterAll(async () => {
    await restoreFx(prisma, saved);
    await app.close();
  });
  beforeEach(reset);

  it('AC9: residual 5100.5 (24 d) + stale rejectedReading => the first real reading is applied', async () => {
    await prisma.fxRateSnapshot.create({
      data: {
        source: 'BCV_USD',
        rate: '5100.5000',
        providerUpdatedAt: ago(24 * 24),
      },
    });
    await prisma.fxRateSetting.update({
      where: { id: 'default' },
      data: {
        lastError: 'Reading rejected: VARIATION_EXCEEDED',
        lastErrorAt: ago(1),
        rejectedReading: {
          source: 'BCV_USD',
          rate: 901.6175,
          rawRate: '901.6175',
          providerUpdatedAt: ago(14 * 24).toISOString(),
          reason: 'VARIATION_EXCEEDED',
          at: ago(14 * 24).toISOString(),
        },
      },
    });
    fake.succeed(920.25, ago(1));
    expect(await fx.refresh()).toMatchObject({
      status: 'UPDATED',
      rate: '920.2500',
    });
    const s = await setting();
    expect(s.vesPerUsd.toFixed(4)).toBe('920.2500');
    expect(s.lastError).toBeNull();
    expect(s.rejectedReading).toBeNull();
    expect((await events())[0].after).not.toHaveProperty(
      'confirmedAfterRejection',
    );
  });

  describe('with a current reference (100 @ 2 h ago)', () => {
    beforeEach(async () => {
      fake.succeed(100, ago(48));
      await fx.refresh();
    });

    it('variation > 15 % is rejected; an isolated one stays rejected', async () => {
      fake.succeed(200, ago(10));
      expect(await fx.refresh()).toMatchObject({
        status: 'REJECTED',
        reason: 'VARIATION_EXCEEDED',
      });
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
      // Same reading again (same date): same data, does not confirm.
      expect((await fx.refresh()).status).toBe('REJECTED');
      // Different value, newer date, not consistent with the candidate.
      fake.succeed(300, ago(5));
      expect((await fx.refresh()).status).toBe('REJECTED');
      const rr = (await setting()).rejectedReading as { rate: number };
      expect(rr.rate).toBe(300);
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
    });

    it('a second consistent reading (+/-0.5 %) with a newer date is CONFIRMED with an event flag', async () => {
      const candAt = ago(10);
      fake.succeed(200, candAt);
      expect((await fx.refresh()).status).toBe('REJECTED');
      fake.succeed(200.9, ago(5));
      expect(await fx.refresh()).toMatchObject({
        status: 'UPDATED',
        rate: '200.9000',
      });
      const s = await setting();
      expect(s.lastError).toBeNull();
      expect(s.rejectedReading).toBeNull();
      const ev = (await events())[0].after;
      expect(ev).toMatchObject({
        confirmedAfterRejection: true,
        candidateProviderUpdatedAt: candAt.toISOString(),
      });
    });

    it.each([
      ['future date', 200, () => new Date(Date.now() + 3_600_000)],
      ['zero', 0, () => ago(1)],
      ['NaN', NaN, () => ago(1)],
    ])(
      'structural failure (%s) is always rejected, even after a candidate',
      async (_n, rate, at) => {
        fake.succeed(200, ago(10));
        await fx.refresh();
        fake.succeed(rate, at());
        expect((await fx.refresh()).status).toBe('REJECTED');
        expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
      },
    );
  });

  it('concurrency: two simultaneous refresh() => one applies, no double event', async () => {
    fake.succeed(500, ago(1));
    const [{ s: head }] = await prisma.$queryRaw<{ s: number }[]>`
      SELECT COALESCE(max("seq"),0)::int AS s FROM "Audit_Events"`;
    const rs = await Promise.all([fx.refresh(), fx.refresh()]);
    expect(rs.filter((r) => r.status === 'UPDATED')).toHaveLength(1);
    expect(
      rs.every((r) => ['UPDATED', 'IN_PROGRESS', 'NOOP'].includes(r.status)),
    ).toBe(true);
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Audit_Events"
      WHERE "action" = 'FX_RATE_CHANGED' AND "seq" > ${head}`;
    expect(n).toBe(1);
  });
});
