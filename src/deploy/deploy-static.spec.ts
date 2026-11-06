import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.10 (QA round 1): two static guards.
 *  - D1: `deploy/deploy.sh` installs (and so runs `prisma generate`, whose config refuses to load without DATABASE_URL)
 *    BEFORE it sources the .env, so the install command must carry its own placeholder DATABASE_URL.
 *  - D5: a `SELECT "x"::text AS "x" ... ORDER BY "x"` sorts by the TEXT alias (SQL: an output name wins over an input
 *    column in a bare ORDER BY), which breaks a numeric keyset cursor across a power of ten.
 */
const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'generated' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('deploy.sh (D1)', () => {
  const script = readFileSync(join(ROOT, 'deploy', 'deploy.sh'), 'utf8');
  const code = script.replace(/^\s*#.*$/gm, '');

  it('pnpm install carries a placeholder DATABASE_URL and runs before the .env is sourced', () => {
    const install = code
      .split('\n')
      .find((l) => /pnpm install --frozen-lockfile\s*$/.test(l));
    expect(install).toBeDefined();
    expect(install).toMatch(
      /^DATABASE_URL="postgresql:\/\/build:build@localhost:\d+\/build"/,
    );
    expect(code.indexOf('pnpm install')).toBeLessThan(
      code.indexOf('source "$ENV_FILE"'),
    );
  });

  it('the placeholder is never exported nor reused after the install', () => {
    expect(code).not.toMatch(/export\s+DATABASE_URL/);
    expect(code.match(/postgresql:\/\/build:build@/g)).toHaveLength(1);
  });
});

describe('text alias in ORDER BY (D5)', () => {
  // Files reviewed by hand: their ids are uuid, and the text of a uuid sorts like the uuid (fixed-width lowercase hex
  // with the hyphens in the same places), so the keyset `id > cursor::uuid` stays consistent with the order.
  const REVIEWED_UUID = ['src/iddoc-migration/iddoc-migration.service.ts'];

  it('no query orders by the text alias of a column it also casts to text', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(ROOT, f);
      if (REVIEWED_UUID.includes(rel)) continue;
      const text = readFileSync(f, 'utf8');
      const re = /(?:"(\w+)"|\b(\w+))::text\s+AS\s+(?:"(\w+)"|\b(\w+))/gi;
      for (const m of text.matchAll(re)) {
        const col = m[1] ?? m[2];
        const alias = m[3] ?? m[4];
        if (col !== alias) continue;
        const after = text.slice(m.index, m.index + 1500);
        const order = new RegExp(`ORDER BY\\s+(?:"${alias}"|${alias})\\b`, 'i');
        if (order.test(after)) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the usage read orders by the bigint column of the table alias', () => {
    const s = readFileSync(join(SRC, 'usage', 'usage-read.service.ts'), 'utf8');
    expect(s).toContain('ORDER BY u."id" DESC');
    expect(s).toContain('FROM "Usage_Logs" u');
  });
});
