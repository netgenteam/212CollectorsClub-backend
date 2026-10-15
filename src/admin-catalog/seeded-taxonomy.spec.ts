import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Franchise, ProductType } from '../generated/prisma/enums.js';
import {
  derivedTagSlugs,
  SEEDED_SLUGS,
  SEEDED_TAXONOMY,
} from './seeded-taxonomy.js';

const SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261015200100_add_product_categories/migration.sql',
  ),
  'utf8',
);

describe('SEEDED_TAXONOMY (Story 13.5 drift guard)', () => {
  it('every slug in the constant appears in the migration SQL', () => {
    for (const slug of SEEDED_SLUGS) {
      expect(SQL).toContain(`'${slug}'`);
    }
  });

  it('every franchise-/format- slug in the SQL is in the constant', () => {
    const sqlSlugs = new Set(
      [...SQL.matchAll(/'((?:franchise|format)-[a-z0-9-]+)'/g)].map(
        (m) => m[1],
      ),
    );
    expect([...sqlSlugs].sort()).toEqual([...SEEDED_SLUGS].sort());
  });

  it('covers every enum value except OTHER / SINGLE_CARD', () => {
    expect(Object.keys(SEEDED_TAXONOMY.franchise).sort()).toEqual(
      Object.values(Franchise)
        .filter((v) => v !== 'OTHER')
        .sort(),
    );
    expect(Object.keys(SEEDED_TAXONOMY.productType).sort()).toEqual(
      Object.values(ProductType)
        .filter((v) => v !== 'SINGLE_CARD')
        .sort(),
    );
  });

  it('the SQL enum literals match the constant keys', () => {
    for (const key of [
      ...Object.keys(SEEDED_TAXONOMY.franchise),
      ...Object.keys(SEEDED_TAXONOMY.productType),
    ]) {
      expect(SQL).toContain(`'${key}'`);
    }
  });

  it('derives tags per AD-38', () => {
    expect(derivedTagSlugs('POKEMON', 'BOOSTER_BOX')).toEqual([
      'franchise-pokemon',
      'format-booster-box',
    ]);
    expect(derivedTagSlugs('POKEMON', 'SINGLE_CARD')).toEqual([
      'franchise-pokemon',
    ]);
    expect(derivedTagSlugs('OTHER', 'SINGLE_CARD')).toEqual([]);
  });
});
