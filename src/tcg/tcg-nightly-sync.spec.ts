import { TcgNightlySyncService } from './tcg-nightly-sync.service.js';
import { TcgApiRateLimitError } from './tcg-api-client.interface.js';

function make(
  env: Record<string, string>,
  overrides: { tryStart?: unknown; client?: unknown; prisma?: unknown } = {},
) {
  const syncRuns = {
    tryStart: vi.fn().mockResolvedValue(overrides.tryStart ?? null),
    finish: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new TcgNightlySyncService(
    (overrides.prisma ?? {}) as never,
    { get: (k: string) => env[k] } as never,
    { upsertPage: vi.fn() } as never,
    syncRuns as never,
    (overrides.client ?? { provider: 'FAKE' }) as never,
  );
  return { svc, syncRuns };
}

describe('TcgNightlySyncService (Story 15.7)', () => {
  it('is disabled unless TCG_NIGHTLY_SYNC_ENABLED is exactly "true"', () => {
    expect(make({}).svc.isEnabled()).toBe(false);
    expect(make({ TCG_NIGHTLY_SYNC_ENABLED: 'false' }).svc.isEnabled()).toBe(
      false,
    );
    expect(make({ TCG_NIGHTLY_SYNC_ENABLED: '1' }).svc.isEnabled()).toBe(false);
    expect(make({ TCG_NIGHTLY_SYNC_ENABLED: 'TRUE' }).svc.isEnabled()).toBe(
      true,
    );
  });

  it('handleCron does not touch the lock when disabled', async () => {
    const { svc, syncRuns } = make({});
    await svc.handleCron();
    expect(syncRuns.tryStart).not.toHaveBeenCalled();
  });

  it('exits without requests when another run holds the lock', async () => {
    const listSetCards = vi.fn();
    const { svc } = make(
      {},
      { tryStart: null, client: { provider: 'FAKE', listSetCards } },
    );
    const res = await svc.runNightlySync();
    expect(res.status).toBe('ALREADY_RUNNING');
    expect(listSetCards).not.toHaveBeenCalled();
  });

  it('stops on HTTP 429 as PARTIAL with quotaExhausted', async () => {
    const listSetCards = vi
      .fn()
      .mockRejectedValue(new TcgApiRateLimitError(new Date(), null));
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { gameSlug: 'g', setId: '1', setName: 'S', cursorId: 'c1' },
        ]),
      tcgIngestCursor: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const { svc, syncRuns } = make(
      {},
      {
        tryStart: { id: 'run-1' },
        prisma,
        client: { provider: 'FAKE', listSetCards },
      },
    );
    const res = await svc.runNightlySync();
    expect(res).toMatchObject({ status: 'PARTIAL', quotaExhausted: true });
    expect(syncRuns.finish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'PARTIAL', quotaExhausted: true }),
    );
  });
});
