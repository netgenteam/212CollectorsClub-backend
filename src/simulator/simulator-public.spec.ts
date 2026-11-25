import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import { PackGeneratorService } from './pack-generator.service.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { defaultPokemonTemplate } from './simulator-defaults.js';
import { SimulatorSetsService } from './simulator-sets.service.js';
import { PACK_TIERS, type PackTier } from './pack-tiers.js';

/** Story 22.8 (AD-108): public simulator over active + ready manual sets (unit, mocked Prisma). */
const SET = '11111111-1111-4111-8111-111111111111';
const MIN: Partial<Record<PackTier, number>> = {
  COMMON: 4,
  UNCOMMON: 3,
  RARE: 3,
  DOUBLE_RARE: 1,
  ULTRA_RARE: 1,
  ILLUSTRATION_RARE: 1,
  SPECIAL_ILLUSTRATION_RARE: 1,
  HYPER_RARE: 1,
};

function cardsOf(tiers: Partial<Record<PackTier, number>>) {
  const out: {
    id: string;
    name: string;
    rarityTier: PackTier;
    number: string | null;
    imageUrl: string | null;
    marketPriceUsd: string | null;
  }[] = [];
  let n = 0;
  for (const t of PACK_TIERS)
    for (let i = 0; i < (tiers[t] ?? 0); i++) {
      n++;
      out.push({
        id: `c${n}`,
        name: `Card ${n}`,
        rarityTier: t,
        number: String(n),
        imageUrl: null,
        marketPriceUsd: n % 2 ? '1.50' : null,
      });
    }
  return out;
}

const countRows = (id: string, tiers: Partial<Record<PackTier, number>>) =>
  PACK_TIERS.filter((t) => tiers[t]).map((t) => ({
    setId: id,
    rarityTier: t,
    n: tiers[t],
  }));

function listFixture(
  sets: {
    id: string;
    name: string;
    tiers: Partial<Record<PackTier, number>>;
    template?: unknown;
  }[],
) {
  const prisma = {
    simulatorSet: {
      findMany: vi.fn().mockResolvedValue(
        sets.map((s) => ({
          id: s.id,
          name: s.name,
          imageUrl: null,
          template: s.template ?? defaultPokemonTemplate(),
        })),
      ),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValue(sets.flatMap((s) => countRows(s.id, s.tiers))),
  };
  const cache = new SimulatorPoolCache();
  const svc = new SimulatorSetsService(
    prisma as never,
    {} as never,
    {} as never,
    cache,
  );
  return { prisma, cache, svc };
}

describe('SimulatorSetsService.listPublic (AC1, AC2)', () => {
  it('lists only ready active sets, sorted, fixed gameSlug, total cardCount; one aggregated count query', async () => {
    const { prisma, svc } = listFixture([
      { id: 'b', name: 'Beta', tiers: MIN },
      { id: 'a', name: 'Alpha', tiers: { ...MIN, COMMON: 10 } },
      { id: 'x', name: 'Broken', tiers: { COMMON: 2 } },
      { id: 'y', name: 'BadTemplate', tiers: MIN, template: { slots: [] } },
    ]);
    const data = await svc.listPublic();
    expect(data.map((d) => d.name)).toEqual(['Alpha', 'Beta']);
    expect(data[0]).toEqual({
      setId: 'a',
      gameSlug: 'pokemon',
      name: 'Alpha',
      cardCount: 21,
      imageUrl: null,
    });
    expect(prisma.simulatorSet.findMany).toHaveBeenCalledTimes(1);
    expect(
      (prisma.simulatorSet.findMany.mock.calls[0] as [{ where: unknown }])[0]
        .where,
    ).toEqual({ isActive: true });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('0 active sets => [] ; result cached 60 s and dropped by poolCache.clear()', async () => {
    const empty = listFixture([]);
    expect(await empty.svc.listPublic()).toEqual([]);

    const { prisma, cache, svc } = listFixture([
      { id: 'a', name: 'Alpha', tiers: MIN },
    ]);
    await svc.listPublic();
    await svc.listPublic();
    expect(prisma.simulatorSet.findMany).toHaveBeenCalledTimes(1);
    cache.clear();
    await svc.listPublic();
    expect(prisma.simulatorSet.findMany).toHaveBeenCalledTimes(2);
  });

  it('a list that was in flight when a write cleared the cache does not repopulate it', async () => {
    const { prisma, cache, svc } = listFixture([
      { id: 'a', name: 'Alpha', tiers: MIN },
    ]);
    let release!: () => void;
    prisma.simulatorSet.findMany.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () =>
            res([
              {
                id: 'a',
                name: 'Stale',
                imageUrl: null,
                template: defaultPokemonTemplate(),
              },
            ]);
        }),
    );
    const inflight = svc.listPublic();
    await Promise.resolve();
    cache.clear();
    release();
    await inflight;
    const fresh = await svc.listPublic();
    expect(fresh[0].name).toBe('Alpha');
  });
});

function openFixture(
  set: Record<string, unknown> | null,
  cards = cardsOf(MIN),
) {
  const prisma = {
    simulatorSet: { findUnique: vi.fn().mockResolvedValue(set) },
    simulatorCard: { findMany: vi.fn().mockResolvedValue(cards) },
  };
  const cache = new SimulatorPoolCache();
  const gen = new PackGeneratorService(prisma as never, cache);
  return { prisma, cache, gen };
}
const row = (over: Record<string, unknown> = {}) => ({
  isActive: true,
  version: 1,
  name: 'My set',
  template: defaultPokemonTemplate(),
  ...over,
});

describe('PackGeneratorService.open (AC3-AC5)', () => {
  it('draws 10 distinct cards, rare last, product null, ids and name from the set', async () => {
    const { gen } = openFixture(row());
    const p = await gen.open(SET);
    expect(p.set).toEqual({ setId: SET, gameSlug: 'pokemon', name: 'My set' });
    expect(p.cards).toHaveLength(10);
    expect(new Set(p.cards.map((c) => c.id)).size).toBe(10);
    expect(p.cards[9].rarityTier).toMatch(/RARE/);
    expect(p.cards.every((c) => c.product === null)).toBe(true);
    expect(p.cards.every((c) => c.rarityRaw === c.rarityTier)).toBe(true);
    expect(p.pricedCards + p.unpricedCards).toBe(10);
    const cents = p.cards.reduce(
      (a, c) => a + Math.round((c.marketPriceUsd ?? 0) * 100),
      0,
    );
    expect(p.totalValueUsd).toBe(cents / 100);
  });

  it('caches the pool per manual:<setId>:<version>; a new version reloads the cards', async () => {
    const { prisma, gen, cache } = openFixture(row());
    await gen.open(SET);
    await gen.open(SET);
    expect(prisma.simulatorCard.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.simulatorSet.findUnique).toHaveBeenCalledTimes(2);
    expect(cache.get(`manual:${SET}:1`)).toBeDefined();
    prisma.simulatorSet.findUnique.mockResolvedValue(row({ version: 2 }));
    await gen.open(SET);
    expect(prisma.simulatorCard.findMany).toHaveBeenCalledTimes(2);
    expect(cache.get(`manual:${SET}:2`)).toBeDefined();
  });

  it('inactive set stops opening at once even with a warm pool', async () => {
    const { prisma, gen } = openFixture(row());
    await gen.open(SET);
    prisma.simulatorSet.findUnique.mockResolvedValue(row({ isActive: false }));
    await expect(gen.open(SET)).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['missing set', null],
    ['inactive set', row({ isActive: false })],
  ])('%s => 404 SIMULATOR_SET_NOT_FOUND, no card query', async (_n, set) => {
    const { prisma, gen } = openFixture(set);
    const err = await gen.open(SET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect((err as ApiException).getResponse()).toMatchObject({
      errorCode: 'SIMULATOR_SET_NOT_FOUND',
    });
    expect(prisma.simulatorCard.findMany).not.toHaveBeenCalled();
  });

  it('non-UUID id => 404 without touching the DB', async () => {
    const { prisma, gen } = openFixture(row());
    await expect(gen.open('nope')).rejects.toMatchObject({ status: 404 });
    expect(prisma.simulatorSet.findUnique).not.toHaveBeenCalled();
  });

  it('InsufficientCardsError / invalid template => 404 + logger.error (broken invariant)', async () => {
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const few = openFixture(row(), cardsOf({ COMMON: 3 }));
    const e1 = await few.gen.open(SET).catch((e: unknown) => e);
    expect((e1 as ApiException).getStatus()).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    const bad = openFixture(row({ template: { slots: [] } }));
    const e2 = await bad.gen.open(SET).catch((e: unknown) => e);
    expect((e2 as ApiException).getStatus()).toBe(404);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('1000 draws on a minimum-ready set: 10 distinct cards, never insufficient', async () => {
    const { gen } = openFixture(row());
    for (let i = 0; i < 1000; i++) {
      const p = await gen.open(SET);
      expect(new Set(p.cards.map((c) => c.id)).size).toBe(10);
    }
  });
});

describe('static guarantees (AC8, AC9)', () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const forbidden =
    /Master_Cards|masterCard|tcgIngestCursor|Tcg_Ingest|landingConfigEntry|pack_simulator|TCG_API_CLIENT|SimulatorConfigService/;

  it('the public pack generator never reads Master_Cards, cursors, the legacy config or the TCG client', () => {
    expect(src('./pack-generator.service.ts')).not.toMatch(forbidden);
  });

  it('listPublic body never reads the legacy sources', () => {
    const s = src('./simulator-sets.service.ts');
    const body = s.slice(
      s.indexOf('async listPublic'),
      s.indexOf('/** Two aggregated queries'),
    );
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toMatch(forbidden);
    expect(body).not.toMatch(/this\.config|this\.tcg/);
  });

  it('the legacy config keeps serving the default template when its row does not exist', async () => {
    const svc = new SimulatorConfigService(
      {
        landingConfigEntry: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      new SimulatorPoolCache(),
    );
    const cfg = await svc.getEffective();
    expect(cfg.templates.pokemon).toEqual(defaultPokemonTemplate());
    expect(cfg.sets).toEqual([]);
  });
});
