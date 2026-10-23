import { describe, expect, it } from 'vitest';
import { isBasicEnergyName, mapPackTier } from './pack-tiers.js';

describe('mapPackTier (Story 16.3, AD-66)', () => {
  const table: [string, string][] = [
    ['Common', 'COMMON'],
    ['Uncommon', 'UNCOMMON'],
    ['Rare', 'RARE'],
    ['Rare Holo', 'RARE'],
    ['Holo Rare', 'RARE'],
    ['Shiny Rare', 'RARE'],
    ['Double Rare', 'DOUBLE_RARE'],
    ['Ultra Rare', 'ULTRA_RARE'],
    ['ACE SPEC Rare', 'ULTRA_RARE'],
    ['Shiny Ultra Rare', 'ULTRA_RARE'],
    ['Rare Ultra', 'ULTRA_RARE'],
    ['Illustration Rare', 'ILLUSTRATION_RARE'],
    ['Special Illustration Rare', 'SPECIAL_ILLUSTRATION_RARE'],
    ['Hyper Rare', 'HYPER_RARE'],
    ['Secret Rare', 'HYPER_RARE'],
    ['Rare Secret', 'HYPER_RARE'],
    ['  SPECIAL ILLUSTRATION RARE  ', 'SPECIAL_ILLUSTRATION_RARE'],
    ['  uNcOmMoN ', 'UNCOMMON'],
    ['DOUBLE   RARE', 'DOUBLE_RARE'],
  ];
  it.each(table)('%s -> %s', (raw, tier) => {
    expect(mapPackTier(raw)).toBe(tier);
  });

  it('special illustration is not illustration', () => {
    expect(mapPackTier('special illustration rare')).not.toBe(
      'ILLUSTRATION_RARE',
    );
  });

  it.each([
    ['Promo'],
    [''],
    ['   '],
    [null],
    [undefined],
    ['Mystery'],
    ['None'],
  ])('%s -> null', (raw) => {
    expect(mapPackTier(raw as string | null)).toBeNull();
  });
});

describe('isBasicEnergyName', () => {
  it('matches ^basic .* energy$', () => {
    expect(isBasicEnergyName('Basic Fire Energy')).toBe(true);
    expect(isBasicEnergyName('basic grass energy')).toBe(true);
    expect(isBasicEnergyName('Double Turbo Energy')).toBe(false);
    expect(isBasicEnergyName('Basic Energy Charm')).toBe(false);
    expect(isBasicEnergyName(null)).toBe(false);
  });
});
