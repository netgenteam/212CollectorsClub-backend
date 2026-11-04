import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../crypto/decrypt-usage.spec.js';
import {
  ADDRESS_RECIPIENT,
  ALL_SETS,
  BACKFILL_SETS,
  SCRUB_SETS,
} from './iddoc-columns.js';

/**
 * Story 20.3, AC8 (FR-129, A86): the cedula of an ORDER is never purged, nulled or masked
 * irreversibly by any script, task or migration of this story. Static guard over every script
 * (`scripts/`, `src/iddoc-migration/`, its CLIs) and the migration of the story.
 */
const root = process.cwd();
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(?:ts|mjs|js|sh|sql)$/.test(n) && !/\.spec\.ts$/.test(n))
      acc.push(p);
  }
  return acc;
};
const scripts = [
  ...walk(join(root, 'scripts')),
  ...walk(join(root, 'src', 'iddoc-migration')),
];
const migration = readdirSync(join(root, 'prisma', 'migrations')).find((d) =>
  d.endsWith('_iddoc_encrypted_columns'),
);

describe('AC8: order ID documents are untouchable by the scripts', () => {
  it('the scan really sees the scripts', () => {
    const names = scripts.map((f) => relative(root, f));
    expect(names).toContain(
      join('src', 'iddoc-migration', 'iddoc-migration.service.ts'),
    );
    expect(names).toContain(join('scripts', 'iddoc-keys.ts'));
  });

  it('no script deletes, truncates or drops (db-roles.sql is the 20.1 role script, which only REVOKEs/GRANTs)', () => {
    for (const f of scripts.filter((x) => !x.endsWith('db-roles.sql'))) {
      const code = stripComments(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(code, f).not.toMatch(/\bTRUNCATE\b/i);
      expect(code, f).not.toMatch(
        /\bDROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)\b/i,
      );
    }
  });

  it('the only statement that nulls a cedula column is the address scrub, and it can only target SCRUB_SETS', () => {
    const svcPath = join(
      root,
      'src',
      'iddoc-migration',
      'iddoc-migration.service.ts',
    );
    const code = stripComments(readFileSync(svcPath, 'utf8'));
    const nulls = code.match(/=\s*NULL/g) ?? [];
    expect(nulls).toHaveLength(1);
    const scrub = code.slice(
      code.indexOf('async scrub('),
      code.indexOf('async reencrypt('),
    );
    expect(scrub).toContain('= NULL');
    expect(scrub).toContain('SCRUB_SETS');
    for (const forbidden of [
      'ALL_SETS',
      'BACKFILL_SETS',
      'ORDER_RECIPIENT',
      'ORDER_BUYER',
      '"Orders"',
      'Orders',
    ])
      expect(scrub, forbidden).not.toContain(forbidden);
    // outside scrub, no UPDATE ever writes NULL or an empty value into a cedula column
    const outside = code.replace(scrub, '');
    expect(outside).not.toMatch(/=\s*NULL/);
    expect(outside).not.toMatch(/=\s*''/);
    for (const s of SCRUB_SETS) expect(s.table).toBe('Customer_Addresses');
    expect(SCRUB_SETS).toEqual([ADDRESS_RECIPIENT]);
  });

  it('order columns are in every set that reads/encrypts, and in none that scrubs', () => {
    expect(ALL_SETS.some((s) => s.table === 'Orders')).toBe(true);
    expect(BACKFILL_SETS.some((s) => s.table === 'Orders')).toBe(true);
    expect(SCRUB_SETS.some((s) => s.table === 'Orders')).toBe(false);
  });

  it('the migration only adds: no DROP COLUMN/TABLE, no UPDATE/DELETE, no SET NOT NULL, no rewrite of Orders data', () => {
    expect(migration).toBeDefined();
    const sql = stripComments(
      readFileSync(
        join(
          root,
          'prisma',
          'migrations',
          migration as string,
          'migration.sql',
        ),
        'utf8',
      ).replace(/--.*$/gm, ''),
    );
    expect(sql).not.toMatch(/\bDROP\s+(?:COLUMN|TABLE|TYPE|INDEX)\b/i);
    expect(sql).not.toMatch(
      /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bSET\s+NOT\s+NULL\b/i,
    );
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+"recipientIdDoc"\s+TYPE/i);
    // the single relaxation of a constraint: the address book plain column becomes nullable
    expect(sql.match(/DROP\s+NOT\s+NULL/gi)).toHaveLength(1);
    expect(sql).toMatch(/^\s*BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    // a later phase-2 migration must NOT exist in the folder yet (Technical Notes of 20.3)
    expect(
      readdirSync(join(root, 'prisma', 'migrations')).filter((d) =>
        /drop_plain_iddoc/.test(d),
      ),
    ).toEqual([]);
  });

  it('deploy.sh runs the keyring check before the restart and the backfill + check after it', () => {
    const sh = readFileSync(join(root, 'deploy', 'deploy.sh'), 'utf8');
    const ring = sh.indexOf('check-keyring.js');
    const restart = sh.indexOf('systemctl restart');
    const backfill = sh.indexOf('backfill_step pnpm iddoc:backfill;');
    const check = sh.indexOf('pnpm iddoc:backfill --check');
    expect(ring).toBeGreaterThan(0);
    expect(ring).toBeLessThan(sh.indexOf('pnpm prisma:deploy'));
    expect(ring).toBeLessThan(restart);
    expect(backfill).toBeGreaterThan(restart);
    expect(check).toBeGreaterThan(backfill);
    // a failing backfill ends the deploy red but never stops/disables the service
    expect(sh).not.toMatch(/systemctl\s+(?:stop|disable)/);
  });
});
