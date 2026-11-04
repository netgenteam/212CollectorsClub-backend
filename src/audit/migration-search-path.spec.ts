import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * Story 20.1 (QA round 3): `pg_dump` starts every dump with an EMPTY search_path, so a
 * function that names a table without a schema fails when a trigger fires during a
 * `--data-only` restore (`relation "Audit_Events" does not exist`). The project's
 * functions are written without schema names (the audit e2e runs them in a sandbox
 * schema), so each one must carry its own `SET search_path`. `CREATE OR REPLACE
 * FUNCTION` DROPS that setting, so what counts is the state after the LAST migration
 * that touched the function: a later replace without `SET search_path` fails here.
 */
export function functionPinState(): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  for (const d of dirs) {
    const sql = readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Statements in file order.
    const re =
      /(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([A-Za-z0-9_]+)"?\s*\([^)]*\)([\s\S]*?)\bAS\s+\$)|(ALTER\s+FUNCTION\s+"?([A-Za-z0-9_]+)"?\s*\([^)]*\)\s+SET\s+search_path)|(DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?)/gi;
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      if (m[2]) state.set(m[2], /\bSET\s+search_path\b/i.test(m[3]));
      else if (m[5]) state.set(m[5], true);
      else if (m[7]) state.delete(m[7]);
    }
  }
  return state;
}

describe('every function created by a migration is pinned to a search_path (restorable)', () => {
  it('finds the known functions (the scanner works)', () => {
    const s = functionPinState();
    for (const f of [
      'audit_events_chain_guard',
      'audit_events_immutable',
      'audit_normalize_ip',
      'legal_guard_rows',
      'legal_guard_version_insert',
      'consent_guard_insert',
      'legal_floor_never_decreases',
    ]) {
      expect(s.has(f), f).toBe(true);
    }
  });

  it('none is left without SET search_path after the last migration', () => {
    const unpinned = [...functionPinState()]
      .filter(([, pinned]) => !pinned)
      .map(([name]) => name);
    expect(unpinned).toEqual([]);
  });
});
