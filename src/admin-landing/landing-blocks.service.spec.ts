import { Prisma } from '../generated/prisma/client.js';
import { resolveDrop212Enabled } from './landing-blocks.normalize.js';
import { LandingBlocksService } from './landing-blocks.service.js';

describe('LandingBlocksService.publishRow (concurrent PUT safety)', () => {
  it('promotes the read draft but clears only if draftUpdatedAt is unchanged', async () => {
    const readAt = new Date('2026-01-01T00:00:00.000Z');
    const tx = {
      landingConfigEntry: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ key: 'ticker' }),
      },
    };
    const service = new LandingBlocksService(
      {} as never,
      {} as never,
      {} as never,
    );
    await (
      service as unknown as {
        publishRow: (...a: unknown[]) => Promise<unknown>;
      }
    ).publishRow(
      tx,
      { key: 'ticker', draftValue: { items: [] }, draftUpdatedAt: readAt },
      'admin-1',
    );

    const upd = tx.landingConfigEntry.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data.value).toEqual({ items: [] });
    // The promotion itself never clears the draft.
    expect(upd.data).not.toHaveProperty('draftValue');
    expect(tx.landingConfigEntry.updateMany).toHaveBeenCalledWith({
      where: { section: 'home', key: 'ticker', draftUpdatedAt: readAt },
      data: {
        draftValue: Prisma.DbNull,
        draftUpdatedAt: null,
        draftUpdatedById: null,
      },
    });
  });
});

describe('resolveDrop212Enabled (Story 21.2, AD-105)', () => {
  const at = new Date('2026-01-01');
  it.each([
    [
      'explicit true wins over published false',
      { enabled: true },
      { value: { enabled: false }, publishedAt: at },
      true,
    ],
    [
      'explicit false wins over legacy published',
      { enabled: false },
      { value: {}, publishedAt: at },
      false,
    ],
    ['explicit true, never published', { enabled: true }, null, true],
    [
      'absent + published with field',
      {},
      { value: { enabled: false }, publishedAt: at },
      false,
    ],
    [
      'absent + published with true',
      {},
      { value: { enabled: true }, publishedAt: at },
      true,
    ],
    [
      'absent + published legacy',
      {},
      { value: { eyebrow: 'x' }, publishedAt: at },
      true,
    ],
    ['absent + no row', {}, null, false],
    [
      'absent + publishedAt NULL (draft-only row)',
      {},
      { value: {}, publishedAt: null },
      false,
    ],
    [
      'absent + publishedAt NULL even if value has enabled',
      {},
      { value: { enabled: true }, publishedAt: null },
      false,
    ],
  ])('%s', (_n, candidate, published, expected) => {
    expect(resolveDrop212Enabled(candidate, published)).toBe(expected);
  });
});

describe('LandingBlocksService drop212 (Story 21.2)', () => {
  const at = new Date('2026-01-01');

  it('publishRow normalizes a legacy draft against the published value, in the tx', async () => {
    const tx = {
      landingConfigEntry: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ value: { eyebrow: 'old' }, publishedAt: at }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({}),
      },
    };
    const service = new LandingBlocksService(
      {} as never,
      {} as never,
      {} as never,
    );
    await (
      service as unknown as {
        publishRow: (...a: unknown[]) => Promise<unknown>;
      }
    ).publishRow(
      tx,
      { key: 'drop212', draftValue: { eyebrow: 'new' }, draftUpdatedAt: at },
      'a',
    );
    const upd = tx.landingConfigEntry.update.mock.calls[0][0] as {
      data: { value: unknown };
    };
    expect(upd.data.value).toEqual({ eyebrow: 'new', enabled: true });
  });

  it('publishRow of a legacy draft never published => enabled:false', async () => {
    const tx = {
      landingConfigEntry: {
        findUnique: vi.fn().mockResolvedValue({ value: {}, publishedAt: null }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({}),
      },
    };
    const service = new LandingBlocksService(
      {} as never,
      {} as never,
      {} as never,
    );
    await (
      service as unknown as {
        publishRow: (...a: unknown[]) => Promise<unknown>;
      }
    ).publishRow(
      tx,
      { key: 'drop212', draftValue: { a: 1 }, draftUpdatedAt: at },
      'a',
    );
    const upd = tx.landingConfigEntry.update.mock.calls[0][0] as {
      data: { value: unknown };
    };
    expect(upd.data.value).toEqual({ a: 1, enabled: false });
  });

  it('getEffectiveDraft synthesizes {enabled:false} for drop212 without rows', async () => {
    const prisma = {
      landingConfigEntry: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new LandingBlocksService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(service.getEffectiveDraft()).resolves.toEqual({
      blocks: { drop212: { enabled: false } },
      draftBlocks: [],
    });
  });

  it('getEffectiveDraft: published legacy => true; draft w/o field inherits', async () => {
    const mk = (over: object) => ({
      key: 'drop212',
      value: { eyebrow: 'p' },
      draftValue: null,
      draftUpdatedAt: null,
      publishedAt: at,
      ...over,
    });
    const run = async (row: object) => {
      const prisma = {
        landingConfigEntry: { findMany: vi.fn().mockResolvedValue([row]) },
      };
      const s = new LandingBlocksService(
        prisma as never,
        {} as never,
        {} as never,
      );
      return (await s.getEffectiveDraft()).blocks.drop212;
    };
    expect(await run(mk({}))).toEqual({ eyebrow: 'p', enabled: true });
    expect(await run(mk({ draftValue: { eyebrow: 'd' } }))).toEqual({
      eyebrow: 'd',
      enabled: true,
    });
    expect(
      await run(
        mk({ value: {}, publishedAt: null, draftValue: { eyebrow: 'd' } }),
      ),
    ).toEqual({ eyebrow: 'd', enabled: false });
    expect(await run(mk({ value: {}, publishedAt: null }))).toEqual({
      enabled: false,
    });
  });

  it('saveDraft without enabled persists the inherited value; explicit is kept', async () => {
    const upsert = vi.fn().mockResolvedValue({
      key: 'drop212',
      value: {},
      draftValue: null,
      draftUpdatedAt: null,
      publishedAt: null,
    });
    const findUnique = vi
      .fn()
      .mockResolvedValue({ value: { eyebrow: 'p' }, publishedAt: at });
    const s = new LandingBlocksService(
      { landingConfigEntry: { upsert, findUnique } } as never,
      {} as never,
      {} as never,
    );
    const { validBlock } = await import('./landing-blocks.fixtures.js');
    await s.saveDraft('drop212', validBlock('drop212'), 'a');
    expect(
      (
        upsert.mock.calls[0][0] as {
          update: { draftValue: { enabled: boolean } };
        }
      ).update.draftValue.enabled,
    ).toBe(true);

    upsert.mockClear();
    findUnique.mockClear();
    await s.saveDraft(
      'drop212',
      { ...validBlock('drop212'), enabled: false },
      'a',
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(
      (
        upsert.mock.calls[0][0] as {
          update: { draftValue: { enabled: boolean } };
        }
      ).update.draftValue.enabled,
    ).toBe(false);
  });
});
