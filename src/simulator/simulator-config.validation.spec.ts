import { describe, expect, it } from 'vitest';
import { parseSimulatorConfig } from './simulator-config.validation.js';
import { defaultSimulatorConfig } from './simulator-defaults.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse(): { errorCode: string } }).getResponse()
      .errorCode;
  }
  return 'OK';
};
const withOdds = (odds: Record<string, number>) => {
  const c = clone(defaultSimulatorConfig());
  (c.templates.pokemon.slots[3] as { odds: unknown }).odds = odds;
  return c;
};
const withSlots = (slots: unknown[]) => ({
  templates: { pokemon: { slots } },
  sets: [],
});

describe('parseSimulatorConfig', () => {
  it('accepts the default (10 cards, odds sum 100)', () => {
    expect(() => parseSimulatorConfig(defaultSimulatorConfig())).not.toThrow();
  });
  it('odds sum tolerance', () => {
    expect(code(() => parseSimulatorConfig(withOdds({ RARE: 99.9 })))).toBe(
      'SIMULATOR_ODDS_INVALID_SUM',
    );
    expect(
      code(() =>
        parseSimulatorConfig(withOdds({ RARE: 60, DOUBLE_RARE: 40.5 })),
      ),
    ).toBe('SIMULATOR_ODDS_INVALID_SUM');
    expect(code(() => parseSimulatorConfig(withOdds({ RARE: 100 })))).toBe(
      'OK',
    );
    expect(code(() => parseSimulatorConfig(withOdds({ RARE: 99.9995 })))).toBe(
      'OK',
    );
  });
  it('rejects non-rare tiers in odds and out-of-range odds', () => {
    expect(code(() => parseSimulatorConfig(withOdds({ COMMON: 100 })))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
    expect(code(() => parseSimulatorConfig(withOdds({ RARE: 101 })))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
  });
  it('slot structure rules', () => {
    const rare = { kind: 'rare', odds: { RARE: 100 } };
    const fx = (count: number) => ({ kind: 'fixed', tier: 'COMMON', count });
    expect(code(() => parseSimulatorConfig(withSlots([rare, fx(1)])))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    ); // rare not last
    expect(code(() => parseSimulatorConfig(withSlots([fx(1)])))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    ); // no rare
    expect(code(() => parseSimulatorConfig(withSlots([rare, rare])))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
    expect(code(() => parseSimulatorConfig(withSlots([fx(9), rare])))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
    expect(
      code(() => parseSimulatorConfig(withSlots([fx(8), fx(7), rare]))),
    ).toBe('SIMULATOR_CONFIG_INVALID'); // 16 cards
    expect(
      code(() => parseSimulatorConfig(withSlots([fx(8), fx(6), rare]))),
    ).toBe('OK'); // 15
    expect(
      code(() =>
        parseSimulatorConfig(withSlots([{ kind: 'reverse', count: 5 }, rare])),
      ),
    ).toBe('SIMULATOR_CONFIG_INVALID');
    expect(code(() => parseSimulatorConfig(withSlots([rare])))).toBe('OK');
  });
  it('sets: imageUrl, limit, shape', () => {
    const set = (extra: object) => ({
      templates: {},
      sets: [{ gameSlug: 'pokemon', setId: '1', ...extra }],
    });
    expect(
      code(() => parseSimulatorConfig(set({ imageUrl: 'https://x/y.png' }))),
    ).toBe('SIMULATOR_CONFIG_INVALID');
    expect(
      code(() =>
        parseSimulatorConfig(
          set({ imageUrl: '/uploads/public/landing/../x.png' }),
        ),
      ),
    ).toBe('SIMULATOR_CONFIG_INVALID');
    expect(
      code(() =>
        parseSimulatorConfig(
          set({ imageUrl: '/uploads/public/landing/a.webp' }),
        ),
      ),
    ).toBe('OK');
    const many = {
      templates: {},
      sets: Array.from({ length: 51 }, (_, i) => ({
        gameSlug: 'p',
        setId: `${i}`,
      })),
    };
    expect(code(() => parseSimulatorConfig(many))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
    expect(code(() => parseSimulatorConfig('x'))).toBe(
      'SIMULATOR_CONFIG_INVALID',
    );
    expect(
      code(() => parseSimulatorConfig({ templates: {}, sets: [], extra: 1 })),
    ).toBe('SIMULATOR_CONFIG_INVALID');
  });
});
