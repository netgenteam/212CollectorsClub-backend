import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.2 (AC5, AD-95): no controller or service outside the allowlist may
 * call `decrypt(`. Views go through `serializeIdDoc` (masked); the full value is
 * only for the reveal endpoint (20.4) and the invoice generator (future).
 * Adding a path here is a privacy decision: it must be reviewed.
 */
const ALLOWLIST: string[] = [
  `src${sep}crypto${sep}`,
  // Story 20.4: admin reveal endpoint (audited before answering).
  // `src${sep}orders${sep}admin-order-reveal...`
  // Future invoice generator.
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('decrypt( usage is confined (AC5)', () => {
  it('appears only in the allowlist', () => {
    const root = process.cwd();
    const offenders = walk(join(root, 'src'))
      .map((f) => relative(root, f))
      .filter((f) => !ALLOWLIST.some((a) => f.startsWith(a)))
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) =>
        /\bdecrypt\s*\(/.test(readFileSync(join(root, f), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });

  it('the guard does detect a call (self-check of the regex)', () => {
    expect(/\bdecrypt\s*\(/.test('crypto.decrypt(x)')).toBe(true);
    expect(/\bdecrypt\s*\(/.test('svc.decrypt (x)')).toBe(true);
    expect(/\bdecrypt\s*\(/.test('decryptedValue(x)')).toBe(false);
  });
});
