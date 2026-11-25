import { describe, expect, it } from 'vitest';
import { buildPoolFromManual } from './manual-pool.js';
import { drawPack } from '../pack-draw.js';

describe('buildPoolFromManual (AC10)', () => {
  const row = (
    o: Partial<Parameters<typeof buildPoolFromManual>[0][number]> & {
      id: string;
    },
  ) => ({
    name: 'Card',
    rarityTier: 'COMMON' as const,
    number: null,
    imageUrl: null,
    marketPriceUsd: null,
    ...o,
  });

  it('groups by tier, no reverse printings, price as number or null', () => {
    const pool = buildPoolFromManual([
      row({ id: 'a', number: '1', marketPriceUsd: '1.25' }),
      row({ id: 'b', rarityTier: 'HYPER_RARE', imageUrl: '/x.png' }),
    ]);
    expect(pool.hasReversePrintings).toBe(false);
    expect(pool.reverse).toEqual([]);
    expect(pool.total).toBe(2);
    expect(pool.byTier.COMMON[0]).toMatchObject({
      id: 'a',
      number: '1',
      rarityRaw: 'COMMON',
      priceCents: 125,
    });
    expect(pool.byTier.HYPER_RARE[0]).toMatchObject({
      priceCents: null,
      imageUrl: '/x.png',
    });
  });

  it('cards without number use id as uniqueness key; same name, different number are distinct', () => {
    const pool = buildPoolFromManual([
      row({ id: 'u1', name: 'Pikachu', number: '1' }),
      row({ id: 'u2', name: 'Pikachu', number: '2' }),
      row({ id: 'u3', name: 'Pikachu' }),
      row({ id: 'u4', name: 'Pikachu' }),
    ]);
    const tpl = {
      slots: [
        { kind: 'fixed' as const, tier: 'COMMON' as const, count: 4 },
        { kind: 'rare' as const, odds: { COMMON: 0, RARE: 100 } },
      ],
    };
    const pool2 = buildPoolFromManual([
      ...[1, 2, 3, 4].map((n) =>
        row({ id: `c${n}`, name: 'Pikachu', number: n > 2 ? null : String(n) }),
      ),
      row({ id: 'r', rarityTier: 'RARE' }),
    ]);
    const pack = drawPack(pool2, tpl);
    expect(pack).toHaveLength(5);
    expect(new Set(pack.map((p) => p.card.id)).size).toBe(5);
    expect(pool.byTier.COMMON).toHaveLength(4);
  });
});
