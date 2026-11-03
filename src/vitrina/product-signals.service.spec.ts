import { describe, expect, it, vi } from 'vitest';
import {
  ProductSignalsService,
  VIEW_DEDUP_MAX_ENTRIES,
  utcDay,
} from './product-signals.service.js';

const mk = () => {
  const prisma = { $executeRaw: vi.fn().mockResolvedValue(1) };
  const svc = new ProductSignalsService(prisma as never);
  return { prisma, svc };
};
const UA = 'Mozilla/5.0 (X11; Linux) Firefox/130';
const T0 = new Date('2026-03-01T10:00:00Z');

describe('ProductSignalsService.recordView', () => {
  it('counts once, then dedupes the same ip+product within the window', async () => {
    const { prisma, svc } = mk();
    expect(await svc.recordView('p1', '1.1.1.1', UA, T0)).toBe(true);
    expect(await svc.recordView('p1', '1.1.1.1', UA, T0)).toBe(false);
    expect(await svc.recordView('p2', '1.1.1.1', UA, T0)).toBe(true);
    expect(await svc.recordView('p1', '2.2.2.2', UA, T0)).toBe(true);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('counts again after the TTL, using the injected clock', async () => {
    const { svc } = mk();
    await svc.recordView('p1', '1.1.1.1', UA, T0);
    const t1 = new Date(T0.getTime() + 1799_000);
    expect(await svc.recordView('p1', '1.1.1.1', UA, t1)).toBe(false);
    const t2 = new Date(T0.getTime() + 1801_000);
    expect(await svc.recordView('p1', '1.1.1.1', UA, t2)).toBe(true);
  });

  it('ignores bots and empty user agents', async () => {
    const { prisma, svc } = mk();
    for (const ua of [
      undefined,
      '',
      '  ',
      'Googlebot/2.1',
      'curl/8.0',
      'HeadlessChrome',
      'Slack link PREVIEW',
      'UptimeMonitor',
    ]) {
      expect(await svc.recordView('p1', '9.9.9.9', ua, T0)).toBe(false);
    }
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('caps the map and evicts the oldest entry', async () => {
    const { svc } = mk();
    for (let i = 0; i < VIEW_DEDUP_MAX_ENTRIES + 10; i++) {
      await svc.recordView('p', `ip-${i}`, UA, T0);
    }
    expect(svc.dedupSize).toBe(VIEW_DEDUP_MAX_ENTRIES);
    // oldest (ip-0) was evicted -> counts again; newest is still deduped
    expect(await svc.recordView('p', 'ip-0', UA, T0)).toBe(true);
    expect(
      await svc.recordView('p', `ip-${VIEW_DEDUP_MAX_ENTRIES + 9}`, UA, T0),
    ).toBe(false);
  }, 60_000);

  it('resets on a new UTC day (salt rotates)', async () => {
    const { svc } = mk();
    await svc.recordView('p1', '1.1.1.1', UA, new Date('2026-03-01T23:59:00Z'));
    expect(
      await svc.recordView(
        'p1',
        '1.1.1.1',
        UA,
        new Date('2026-03-02T00:00:01Z'),
      ),
    ).toBe(true);
  });

  it('never throws when the DB fails', async () => {
    const { prisma, svc } = mk();
    prisma.$executeRaw.mockRejectedValue(new Error('boom 1.1.1.1'));
    await expect(svc.recordView('p1', '1.1.1.1', UA, T0)).resolves.toBe(false);
  });
});

describe('utcDay / purge', () => {
  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-03-01T23:30:00-05:00'))).toBe('2026-03-02');
  });

  it('purge loops by batches until a short batch', async () => {
    const { prisma, svc } = mk();
    prisma.$executeRaw
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    expect(await svc.purgeOldStats(T0, 2)).toBe(5);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
