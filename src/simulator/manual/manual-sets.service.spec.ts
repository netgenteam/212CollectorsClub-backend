import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/api-exception.js';
import { defaultPokemonTemplate } from '../simulator-defaults.js';
import { assertReadyIfActive, countCardsByTier } from './assert-ready.js';
import { ManualSetsService, toSetDto } from './manual-sets.service.js';

const TPL = defaultPokemonTemplate();
const row = (id: string) => ({
  id,
  name: id,
  imageUrl: null,
  isActive: false,
  template: TPL as never,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('countCardsByTier / assertReadyIfActive (AC2, AC7)', () => {
  it('one query for any number of sets; none for zero', async () => {
    const q = vi.fn().mockResolvedValue([]);
    await countCardsByTier({ $queryRaw: q } as never, ['a']);
    await countCardsByTier(
      { $queryRaw: q } as never,
      Array.from({ length: 20 }, (_, i) => `s${i}`),
    );
    expect(q).toHaveBeenCalledTimes(2);
    await countCardsByTier({ $queryRaw: q } as never, []);
    expect(q).toHaveBeenCalledTimes(2);
  });

  const tx = (isActive: boolean, counts: object[]) => {
    const q = vi
      .fn()
      .mockResolvedValueOnce([{ isActive, template: TPL }])
      .mockResolvedValueOnce(counts);
    return { $queryRaw: q };
  };

  it('inactive set: nothing checked beyond the row read', async () => {
    const t = tx(false, []);
    await expect(assertReadyIfActive(t as never, 'x')).resolves.toBeUndefined();
    expect(t.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('active and not ready: 422 with details.missing', async () => {
    const t = tx(true, [{ setId: 'x', rarityTier: 'COMMON', n: 1 }]);
    const err = await assertReadyIfActive(t as never, 'x').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiException);
    const e = err as ApiException;
    expect(e.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    const body = e.getResponse() as {
      errorCode: string;
      details: { missing: { slot: string }[] };
    };
    expect(body.errorCode).toBe('SIMULATOR_SET_NOT_READY');
    expect(body.details.missing.map((m) => m.slot)).toContain('fixed:COMMON');
  });

  it('active and ready: passes', async () => {
    const big = (tier: string) => ({ setId: 'x', rarityTier: tier, n: 20 });
    const t = tx(
      true,
      [
        'COMMON',
        'UNCOMMON',
        'RARE',
        'DOUBLE_RARE',
        'ULTRA_RARE',
        'ILLUSTRATION_RARE',
        'SPECIAL_ILLUSTRATION_RARE',
        'HYPER_RARE',
      ].map(big),
    );
    await expect(assertReadyIfActive(t as never, 'x')).resolves.toBeUndefined();
  });

  it('active with an invalid template: 422 with reason TEMPLATE_INVALID and empty missing', async () => {
    const q = vi
      .fn()
      .mockResolvedValueOnce([{ isActive: true, template: { slots: [] } }])
      .mockResolvedValueOnce([]);
    const e = (await assertReadyIfActive({ $queryRaw: q } as never, 'x').catch(
      (x: unknown) => x,
    )) as ApiException;
    expect((e.getResponse() as { details: unknown }).details).toEqual({
      missing: [],
      reason: 'TEMPLATE_INVALID',
    });
  });
});

describe('ManualSetsService (AC2, AC12)', () => {
  const make = (rows: number) => {
    const ids = Array.from({ length: rows }, (_, i) => `id-${i}`);
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw,
      simulatorSet: {
        count: vi.fn().mockResolvedValue(rows),
        findMany: vi.fn().mockResolvedValue(ids.map(row)),
      },
    };
    const cache = { clear: vi.fn() };
    const audit = { transaction: vi.fn() };
    return {
      svc: new ManualSetsService(
        prisma as never,
        audit as never,
        cache as never,
      ),
      $queryRaw,
      cache,
      audit,
    };
  };

  it('list issues a constant number of aggregate queries for 1 and 20 sets', async () => {
    const one = make(1);
    await one.svc.list({ page: 1, limit: 20 });
    const many = make(20);
    const res = await many.svc.list({ page: 1, limit: 20 });
    expect(one.$queryRaw).toHaveBeenCalledTimes(1);
    expect(many.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.data).toHaveLength(20);
    expect(res.meta.total).toBe(20);
  });

  it('a failed transaction does not clear the pool cache', async () => {
    const m = make(0);
    m.audit.transaction.mockRejectedValue(new Error('boom'));
    await expect(
      m.svc.update(
        '00000000-0000-4000-8000-000000000000',
        { isActive: true },
        undefined,
      ),
    ).rejects.toThrow('boom');
    await expect(
      m.svc.remove('00000000-0000-4000-8000-000000000000', undefined),
    ).rejects.toThrow('boom');
    await expect(m.svc.create({ name: 'x' }, undefined)).rejects.toThrow(
      'boom',
    );
    expect(m.cache.clear).not.toHaveBeenCalled();
  });

  it('a committed write clears the pool cache once; an idempotent one does not', async () => {
    const m = make(0);
    m.audit.transaction.mockResolvedValueOnce({
      row: row('a'),
      counts: {},
      wrote: true,
    });
    await m.svc.update(
      '00000000-0000-4000-8000-000000000000',
      { name: 'z' },
      undefined,
    );
    expect(m.cache.clear).toHaveBeenCalledTimes(1);
    m.audit.transaction.mockResolvedValueOnce({
      row: row('a'),
      counts: {},
      wrote: false,
    });
    await m.svc.update('00000000-0000-4000-8000-000000000000', {}, undefined);
    expect(m.cache.clear).toHaveBeenCalledTimes(1);
  });

  it('toSetDto exposes the 8 tiers, counts and readiness', () => {
    const d = toSetDto(row('a'), { COMMON: 4 });
    expect(Object.keys(d.cardCountByTier)).toHaveLength(8);
    expect(d.cardCount).toBe(4);
    expect(d.readiness.ready).toBe(false);
    expect(d.readiness.missing.length).toBeGreaterThan(0);
  });
});
