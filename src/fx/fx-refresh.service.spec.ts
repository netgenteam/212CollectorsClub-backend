import { vi } from 'vitest';
import { FxRefreshService } from './fx-refresh.service.js';
import type { FxProvider, FxProviderResult } from './fx-provider.js';

const D = new Date(Date.now() - 86_400_000);
const ok = (rate: number): FxProviderResult => ({
  ok: true,
  reading: { rate, providerUpdatedAt: D },
});

/** Story 22.2 (AD-110): phases A/B with mocks (no DB). */
describe('FxRefreshService phases (unit, Story 22.2)', () => {
  const build = (
    active: string,
    results: Record<string, FxProviderResult>,
    lock = true,
    lockedActive = active,
  ) => {
    const fetchRate = vi.fn((s: string) => Promise.resolve(results[s]));
    const provider = { name: 't', fetchRate } as unknown as FxProvider;
    const executed: string[] = [];
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ locked: lock }])
        .mockResolvedValueOnce([
          { source: lockedActive, maxVariationPct: { toNumber: () => 15 } },
        ]),
      $executeRaw: vi.fn((parts: TemplateStringsArray) => {
        executed.push(parts.join('?'));
        return Promise.resolve(1);
      }),
      fxSourceState: { findUnique: vi.fn().mockResolvedValue(null) },
      fxRateSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      fxRateSetting: {
        findUnique: vi.fn().mockResolvedValue({ source: active }),
      },
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const audit = {
      transaction: vi
        .fn()
        .mockResolvedValue({ status: 'NOOP', source: active }),
    };
    const config = { get: vi.fn() };
    const svc = new FxRefreshService(
      prisma as never,
      config as never,
      provider,
      audit as never,
    );
    return { svc, fetchRate, prisma, audit, tx, executed };
  };
  const all = {
    BCV_USD: ok(900),
    BCV_EUR: ok(1000),
    PARALELO_USD: ok(1100),
  };

  it("scope 'all' fetches the 3 sources and returns the active one's result", async () => {
    const { svc, fetchRate, audit } = build('BCV_USD', all);
    expect(await svc.refresh()).toEqual({ status: 'NOOP', source: 'BCV_USD' });
    expect(fetchRate.mock.calls.map((c) => c[0]).sort()).toEqual([
      'BCV_EUR',
      'BCV_USD',
      'PARALELO_USD',
    ]);
    expect(audit.transaction).toHaveBeenCalledTimes(1);
  });

  it("scope 'active' fetches only the active source and skips phase B", async () => {
    const { svc, fetchRate, prisma } = build('BCV_EUR', all);
    await svc.refresh(undefined, { scope: 'active' });
    expect(fetchRate.mock.calls.map((c) => c[0])).toEqual(['BCV_EUR']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('MANUAL: phase A is omitted ({status: MANUAL}) but phase B records the 3 sources', async () => {
    const { svc, fetchRate, audit, executed } = build('MANUAL', all);
    expect(await svc.refresh()).toEqual({ status: 'MANUAL' });
    expect(fetchRate).toHaveBeenCalledTimes(3);
    expect(audit.transaction).not.toHaveBeenCalled();
    expect(
      executed.filter((q) => q.includes('Fx_Rate_Snapshots')),
    ).toHaveLength(3);
    expect(executed.filter((q) => q.includes('Fx_Source_States'))).toHaveLength(
      3,
    );
  });

  it('a non-active source is SKIPPED without network', async () => {
    const { svc, fetchRate } = build('BCV_USD', all);
    expect(await svc.refresh('PARALELO_USD')).toEqual({ status: 'SKIPPED' });
    expect(fetchRate).not.toHaveBeenCalled();
  });

  it('phase B skips the sources when the shared lock is not obtained', async () => {
    const { svc, executed } = build('BCV_USD', all, false);
    await svc.refresh();
    expect(executed).toEqual([]);
  });

  it('a source that became active under the lock is skipped by phase B', async () => {
    const { svc, executed } = build('BCV_USD', all, true, 'BCV_EUR');
    await svc.refresh();
    // only PARALELO_USD (snapshot + state); BCV_EUR is the active one now
    expect(
      executed.filter((q) => q.includes('Fx_Rate_Snapshots')),
    ).toHaveLength(1);
  });

  it('a failing source is data: the others are still recorded, the failed one only gets its state', async () => {
    const { svc, executed } = build('BCV_USD', {
      ...all,
      BCV_EUR: { ok: false, error: 'HTTP 500' },
    });
    await expect(svc.refresh()).resolves.toMatchObject({ status: 'NOOP' });
    expect(
      executed.filter((q) => q.includes('Fx_Rate_Snapshots')),
    ).toHaveLength(1);
    expect(executed.filter((q) => q.includes('Fx_Source_States'))).toHaveLength(
      2,
    );
  });

  it('phase B runs even if phase A throws, and the error still surfaces', async () => {
    const { svc, audit, executed } = build('BCV_USD', all);
    audit.transaction.mockRejectedValue(new Error('boom'));
    await expect(svc.refresh()).rejects.toThrow('boom');
    expect(
      executed.filter((q) => q.includes('Fx_Rate_Snapshots')),
    ).toHaveLength(2);
  });
});
