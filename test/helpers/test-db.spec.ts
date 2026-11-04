import { describe, expect, it } from 'vitest';
import {
  assertThrowawayUrl,
  dbNameOf,
  isThrowawayDbName,
  withDbName,
} from './test-db.js';

describe('throw-away e2e database guard (Story 20.5)', () => {
  const dev =
    'postgresql://u:p@localhost:5433/collectorsclub_dev?schema=public';
  const clone = withDbName(dev, 'collectorsclub_dev_e2e_1793000000_a1b2c3d4');

  it('only an exact <name>_e2e_<epoch>_<hex8> database is throw-away', () => {
    expect(
      isThrowawayDbName('collectorsclub_dev_e2e_1793000000_a1b2c3d4'),
    ).toBe(true);
    for (const bad of [
      'collectorsclub_dev',
      'collectorsclub_dev_e2e',
      'collectorsclub_dev_e2e_1793000000',
      'collectorsclub_dev_e2e_1793000000_a1b2c3d',
      'collectorsclub_dev_e2e_1793000000_A1B2C3D4',
      'collectorsclub_dev_e2e_1793000000_a1b2c3d4x',
      'postgres',
      'q204_clone',
    ]) {
      expect(isThrowawayDbName(bad)).toBe(false);
    }
  });

  it('the real database URL is refused, the clone accepted; query string and credentials untouched', () => {
    expect(() => assertThrowawayUrl(dev, 'DATABASE_URL')).toThrow(
      /not a throw-away/,
    );
    expect(() => assertThrowawayUrl(undefined, 'DATABASE_URL')).toThrow(
      /not set/,
    );
    expect(() => assertThrowawayUrl(clone, 'DATABASE_URL')).not.toThrow();
    expect(dbNameOf(clone)).toBe('collectorsclub_dev_e2e_1793000000_a1b2c3d4');
    expect(new URL(clone).searchParams.get('schema')).toBe('public');
    expect(new URL(clone).username).toBe('u');
    expect(new URL(clone).password).toBe('p');
  });
});
