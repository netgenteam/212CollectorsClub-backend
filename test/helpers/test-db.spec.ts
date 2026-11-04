import { describe, expect, it, vi } from 'vitest';
import { assertDroppable } from './global-test-db.js';
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

describe('positive check before the teardown DROP (Story 20.5 follow-up)', () => {
  const clone = 'collectorsclub_dev_e2e_1793000000_a1b2c3d4';
  const marker = 'cc-e2e-throwaway run=0123456789abcdef';
  const protectedNames = ['collectorsclub_dev', 'collectorsclub_e2e_template'];
  const client = (rows: { marker: string | null }[]) => ({
    query: vi.fn().mockResolvedValue({ rows }),
  });

  it("passes only for a clone that exists and carries THIS run's marker", async () => {
    const c = client([{ marker }]);
    await expect(
      assertDroppable(c as never, clone, marker, protectedNames),
    ).resolves.toBeUndefined();
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that is not a clone name, or a configured database, without asking the server', async () => {
    for (const name of [
      'collectorsclub_dev',
      'postgres',
      'collectorsclub_e2e_template',
    ]) {
      const c = client([{ marker }]);
      await expect(
        assertDroppable(c as never, name, marker, protectedNames),
      ).rejects.toThrow(/Refusing to DROP/);
      expect(c.query).not.toHaveBeenCalled();
    }
    // a clone-shaped name that IS the configured database is refused too
    await expect(
      assertDroppable(client([{ marker }]) as never, clone, marker, [clone]),
    ).rejects.toThrow(/configured database/);
  });

  it("refuses a database that does not exist, or whose comment is not this run's marker (created by someone else, or by an older run)", async () => {
    await expect(
      assertDroppable(client([]) as never, clone, marker, protectedNames),
    ).rejects.toThrow(/does not exist/);
    await expect(
      assertDroppable(
        client([{ marker: null }]) as never,
        clone,
        marker,
        protectedNames,
      ),
    ).rejects.toThrow(/not the marker of this run/);
    await expect(
      assertDroppable(
        client([{ marker: 'cc-e2e-throwaway run=ffffffffffffffff' }]) as never,
        clone,
        marker,
        protectedNames,
      ),
    ).rejects.toThrow(/not the marker of this run/);
  });
});
