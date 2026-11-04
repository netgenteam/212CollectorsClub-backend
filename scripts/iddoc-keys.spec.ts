import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseIdDocKeyring } from '../src/crypto/id-doc-keyring.js';
import { KeysRefused, ensureIdDocKeys } from './iddoc-keys.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'iddoc-keys-'));
const parse = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

describe('pnpm iddoc:keys (ensureIdDocKeys)', () => {
  it('creates the three lines in a missing file (0600) with a valid keyring', () => {
    const path = join(tmp(), '.env');
    const r = ensureIdDocKeys(path, {});
    expect(r.added.sort()).toEqual([
      'IDDOC_BLIND_KEY',
      'IDDOC_ENC_ACTIVE_KEY',
      'IDDOC_ENC_KEYS',
    ]);
    expect(r.problems).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const v = parse(readFileSync(path, 'utf8'));
    expect(() =>
      parseIdDocKeyring({
        encKeys: v.IDDOC_ENC_KEYS,
        activeKey: v.IDDOC_ENC_ACTIVE_KEY,
        blindKey: v.IDDOC_BLIND_KEY,
      }),
    ).not.toThrow();
  });

  it('is idempotent: a second run changes nothing', () => {
    const path = join(tmp(), '.env');
    ensureIdDocKeys(path, {});
    const before = readFileSync(path, 'utf8');
    const r = ensureIdDocKeys(path, {});
    expect(r.added).toEqual([]);
    expect(r.kept).toHaveLength(3);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('appends only the missing ones and never touches existing lines or other content', () => {
    const path = join(tmp(), '.env');
    const original =
      'DATABASE_URL="postgresql://x:y@h/db"\n# comment\nIDDOC_ENC_ACTIVE_KEY=3\nOTHER=1'; // no trailing newline
    writeFileSync(path, original);
    const r = ensureIdDocKeys(path, {});
    expect(r.added.sort()).toEqual(['IDDOC_BLIND_KEY', 'IDDOC_ENC_KEYS']);
    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(original + '\n')).toBe(true); // the original bytes are intact
    expect(parse(after).IDDOC_ENC_ACTIVE_KEY).toBe('3');
    expect(after.match(/IDDOC_ENC_ACTIVE_KEY/g)).toHaveLength(1);
    // active=3 does not exist in the generated ring (1): reported by NAME, nothing rewritten
    expect(r.problems.join(' ')).toContain('IDDOC_ENC_ACTIVE_KEY=3');
  });

  it('active key defaults to the highest existing version when only that line is missing', () => {
    const path = join(tmp(), '.env');
    const k = (): string =>
      Buffer.from(
        Array.from({ length: 32 }, () => Math.floor(Math.random() * 255) + 1),
      ).toString('base64');
    writeFileSync(
      path,
      `IDDOC_ENC_KEYS=1:${k()},2:${k()}\nIDDOC_BLIND_KEY=${k()}\n`,
    );
    const r = ensureIdDocKeys(path, {});
    expect(r.added).toEqual(['IDDOC_ENC_ACTIVE_KEY']);
    expect(parse(readFileSync(path, 'utf8')).IDDOC_ENC_ACTIVE_KEY).toBe('2');
    expect(r.problems).toEqual([]);
  });

  it('a placeholder copied from .env.example is left alone and reported by name, not value', () => {
    const path = join(tmp(), '.env');
    writeFileSync(
      path,
      'IDDOC_ENC_KEYS=1:<generate with: openssl rand -base64 32>\nIDDOC_ENC_ACTIVE_KEY=1\nIDDOC_BLIND_KEY=<generate with: openssl rand -base64 32>\n',
    );
    const before = readFileSync(path, 'utf8');
    const r = ensureIdDocKeys(path, {});
    expect(r.added).toEqual([]);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('never prints a key (the module has no console output of values)', () => {
    const src = readFileSync(join(__dirname, 'iddoc-keys.ts'), 'utf8');
    // every console.* call prints only names, counts or fixed text
    const calls = src.match(/console\.(?:log|error)\([^;]*;/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls)
      expect(c).not.toMatch(/\b(?:encKeys|blind|active|toAdd|block|text)\b/);
  });

  it('refuses to run in production, under /opt/212cc, or on a file that declares production', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    expect(() => ensureIdDocKeys(path, { NODE_ENV: 'production' })).toThrow(
      KeysRefused,
    );
    expect(existsSync(path)).toBe(false);
    expect(() =>
      ensureIdDocKeys('/opt/212cc/production/shared/.env', {}),
    ).toThrow(KeysRefused);
    writeFileSync(path, 'NODE_ENV=production\n');
    chmodSync(path, 0o600);
    expect(() => ensureIdDocKeys(path, {})).toThrow(KeysRefused);
    expect(readFileSync(path, 'utf8')).toBe('NODE_ENV=production\n');
  });

  it.each([
    'NODE_ENV = production # live',
    'export NODE_ENV=production',
    '  export   NODE_ENV = "production"   # x',
    "NODE_ENV='production'",
    'NODE_ENV=Production\r',
    'FOO=1\r\nNODE_ENV=production\r\nBAR=2\r\n',
  ])('refuses a target file with %j', (line) => {
    const dir = tmp();
    const path = join(dir, '.env');
    writeFileSync(path, `${line}\n`);
    chmodSync(path, 0o600);
    expect(() => ensureIdDocKeys(path, {})).toThrow(KeysRefused);
    expect(readFileSync(path, 'utf8')).toBe(`${line}\n`);
  });

  it.each([
    'NODE_ENV=development',
    '# NODE_ENV=production',
    'NODE_ENV_X=production',
    'NODE_ENV=production-like',
  ])('does not mistake %j for production', (line) => {
    const dir = tmp();
    const path = join(dir, '.env');
    writeFileSync(path, `${line}\n`);
    chmodSync(path, 0o600);
    expect(() => ensureIdDocKeys(path, {})).not.toThrow();
  });
});
