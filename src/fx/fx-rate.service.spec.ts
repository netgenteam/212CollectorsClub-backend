import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { FxRateService } from './fx-rate.service.js';

const H = 3600 * 1000;
function row(over: Record<string, unknown> = {}) {
  return {
    vesPerUsd: new Prisma.Decimal('889.26'),
    source: 'BCV_USD',
    maxAgeHours: 48,
    updatedAt: new Date(),
    rateFetchedAt: new Date(),
    providerUpdatedAt: null,
    ...over,
  };
}
const txOf = (r: unknown) => ({
  fxRateSetting: { findUnique: vi.fn().mockResolvedValue(r) },
});
const svc = (r: unknown = row()) =>
  new FxRateService({
    fxRateSetting: { findUnique: vi.fn().mockResolvedValue(r) },
  } as never);

describe('FxRateService (Story 18.3, AD-80)', () => {
  it('getForCheckout: one SELECT on the given tx, coherent (rate, source), no network', async () => {
    const tx = txOf(row({ source: 'BCV_EUR' }));
    const out = await svc().getForCheckout(tx);
    expect(tx.fxRateSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('BCV_EUR');
    expect(out.vesPerUsd.toFixed(2)).toBe('889.26');
  });

  it.each([
    ['missing row', null],
    ['rate 0', row({ vesPerUsd: new Prisma.Decimal(0) })],
    ['rate < 0', row({ vesPerUsd: new Prisma.Decimal(-1) })],
    [
      'older than maxAge x3',
      row({ rateFetchedAt: new Date(Date.now() - 145 * H) }),
    ],
    [
      'rateFetchedAt null falls back to updatedAt',
      row({ rateFetchedAt: null, updatedAt: new Date(Date.now() - 145 * H) }),
    ],
  ])('503 FX_RATE_UNAVAILABLE: %s', async (_n, r) => {
    await expect(svc().getForCheckout(txOf(r) as never)).rejects.toMatchObject({
      status: 503,
      response: { errorCode: 'FX_RATE_UNAVAILABLE' },
    });
    await expect(svc(r).getCurrent()).rejects.toMatchObject({ status: 503 });
  });

  it('between maxAge and x3 still operates (A54) and is stale', async () => {
    const r = row({ rateFetchedAt: new Date(Date.now() - 60 * H) });
    await expect(svc().getForCheckout(txOf(r) as never)).resolves.toBeTruthy();
    expect((await svc(r).getCurrent()).stale).toBe(true);
  });

  it('MANUAL never expires', async () => {
    const r = row({
      source: 'MANUAL',
      rateFetchedAt: new Date(Date.now() - 9999 * H),
    });
    await expect(svc().getForCheckout(txOf(r) as never)).resolves.toBeTruthy();
    expect((await svc(r).getCurrent()).stale).toBe(false);
  });

  it('getCurrent: 4dp string, updatedAt = providerUpdatedAt ?? rateFetchedAt, no extra fields', async () => {
    const at = new Date('2026-11-01T12:00:00.000Z');
    const out = await svc(row({ providerUpdatedAt: at })).getCurrent();
    expect(out).toEqual({
      vesPerUsd: '889.2600',
      source: 'BCV_USD',
      updatedAt: at.toISOString(),
      stale: false,
    });
    const fetched = new Date();
    expect(
      (await svc(row({ rateFetchedAt: fetched })).getCurrent()).updatedAt,
    ).toBe(fetched.toISOString());
  });
});
