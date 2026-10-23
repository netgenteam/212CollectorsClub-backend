import type { PackTier } from './pack-tiers.js';

export type RareOdds = Partial<Record<PackTier, number>>;
export type Slot =
  | { kind: 'fixed'; tier: PackTier; count: number }
  | { kind: 'reverse'; count: number }
  | { kind: 'rare'; odds: RareOdds };
export interface Template {
  slots: Slot[];
}
export interface SimulatorSetConfig {
  gameSlug: string;
  setId: string;
  displayName?: string;
  imageUrl?: string;
  template?: Template;
}
export interface SimulatorConfig {
  templates: Record<string, Template>;
  sets: SimulatorSetConfig[];
}

/** Story 16.3 (AD-66): default `pokemon` template, 4+3+2+1 = 10 cards, odds sum 100. */
export function defaultPokemonTemplate(): Template {
  return {
    slots: [
      { kind: 'fixed', tier: 'COMMON', count: 4 },
      { kind: 'fixed', tier: 'UNCOMMON', count: 3 },
      { kind: 'reverse', count: 2 },
      {
        kind: 'rare',
        odds: {
          RARE: 70,
          DOUBLE_RARE: 15,
          ULTRA_RARE: 6,
          ILLUSTRATION_RARE: 6,
          SPECIAL_ILLUSTRATION_RARE: 2,
          HYPER_RARE: 1,
        },
      },
    ],
  };
}

export function defaultSimulatorConfig(): SimulatorConfig {
  return { templates: { pokemon: defaultPokemonTemplate() }, sets: [] };
}
