import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.2 (AC5, AD-95), widened in 20.3: nothing outside the allowlist may decrypt a cedula.
 * Views go through `serializeIdDoc` (masked); the full value is only for the reveal endpoint
 * (20.4) and the invoice generator (future). Adding a path here is a privacy decision.
 *
 * The scan covers `src/`, `scripts/` and `prisma/*.ts` (seeds) and flags the token `decrypt` in
 * ANY position, not only a call: `svc['decrypt'](x)`, `const d = svc.decrypt`, `d.call(svc, x)`,
 * `Reflect.get(svc, 'decrypt')`, a destructured `{ decrypt }`; and the Node primitives
 * (`createDecipher`, `createDecipheriv`, `privateDecrypt`, `subtle.decrypt`). Comments are
 * ignored; a literal split to dodge the scan (`'dec' + 'rypt'`) is flagged too.
 */
export const ALLOWLIST: string[] = [
  `src${sep}crypto${sep}`,
  // Story 20.4: admin reveal endpoint (audited before answering).
  // `src${sep}orders${sep}admin-order-reveal...`
  // Future invoice generator.
];

const SCANNED_ROOTS = ['src', 'scripts', 'prisma'];
const EXT = /\.(?:ts|mts|cts|js|mjs|cjs|sh)$/;

/** Code without comments (strings are kept: `'decrypt'` is still a way to reach the method). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export const DECRYPT_PATTERNS: RegExp[] = [
  /\bdecrypt\b/,
  /\bcreateDecipher(?:iv)?\b/,
  /\bprivateDecrypt\b|\bpublicDecrypt\b/,
  /['"`]dec['"`]\s*\+|\+\s*['"`]rypt['"`]|['"`]decr['"`]\s*\+|\+\s*['"`]ypt['"`]/,
];

export const usesDecrypt = (src: string): boolean => {
  const code = stripComments(src);
  return DECRYPT_PATTERNS.some((re) => re.test(code));
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'generated' ||
      name === 'migrations'
    )
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (EXT.test(p)) acc.push(p);
  }
  return acc;
}

describe('decrypt usage is confined (AC5, widened in 20.3)', () => {
  it('appears only in the allowlist (src, scripts, prisma seeds)', () => {
    const root = process.cwd();
    const files = SCANNED_ROOTS.flatMap((r) => walk(join(root, r)));
    expect(files.length).toBeGreaterThan(50); // the walk really saw the tree
    expect(files.some((f) => f.includes(`scripts${sep}iddoc-keys.ts`))).toBe(
      true,
    );
    const offenders = files
      .map((f) => relative(root, f))
      .filter((f) => !ALLOWLIST.some((a) => f.startsWith(a)))
      .filter((f) => !/\.spec\.ts$/.test(f))
      .filter((f) => usesDecrypt(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['direct call', 'crypto.decrypt(x)'],
    ['spaced call', 'svc.decrypt (x)'],
    ['bracket call', "svc['decrypt'](x)"],
    ['template bracket', 'svc[`decrypt`](x)'],
    ['alias', 'const d = svc.decrypt;'],
    ['.call', 'svc.decrypt.call(svc, x)'],
    ['.apply / .bind', 'const f = svc.decrypt.bind(svc);'],
    ['destructuring', 'const { decrypt } = svc;'],
    ['Reflect.get', "Reflect.get(svc, 'decrypt')"],
    ['createDecipheriv', "createDecipheriv('aes-256-gcm', k, iv)"],
    ['createDecipher', "crypto.createDecipher('aes', k)"],
    ['privateDecrypt', 'privateDecrypt(key, buf)'],
    ['subtle', 'await crypto.subtle.decrypt(alg, key, data)'],
    ['split literal', "svc['dec' + 'rypt'](x)"],
    ['split literal 2', "svc['decr' + 'ypt'](x)"],
  ])('detects: %s', (_name, code) => {
    expect(usesDecrypt(code), code).toBe(true);
  });

  it.each([
    [
      'unrelated names',
      'const decryptedCount = 1; undecryptable++; decryption',
    ],
    ['a comment', '// we never decrypt( here\n/* decrypt */ const a = 1;'],
    ['a constant', "throw new Error('IDDOC_DECRYPT_FAILED')"],
  ])('does not flag: %s', (_name, code) => {
    expect(usesDecrypt(code), code).toBe(false);
  });
});
