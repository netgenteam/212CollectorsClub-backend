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
/**
 * Exact FILES, not directories (Story 20.4 narrowed it): a new file in `src/crypto/` is not
 * allowed to decrypt just for living there. Each entry must really use `decrypt` (checked below),
 * so an entry cannot outlive its need.
 */
export const ALLOWLIST: string[] = [
  // The service itself: encrypt/decrypt, `checkStored`, `typeOfStored`, re-encryption.
  `src${sep}crypto${sep}id-doc-crypto.service.ts`,
  // THE masked serializer of every non-admin view (decrypts, masks, never returns the value).
  `src${sep}crypto${sep}id-doc-serialize.ts`,
  // Story 20.4: the audited admin reveal (commits the audit event before it returns the value).
  `src${sep}crypto${sep}id-doc-reveal.service.ts`,
  // Future invoice generator: add its file here when it exists (a privacy decision).
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

  it('the allowlist is minimal: every entry exists and uses decrypt', () => {
    const root = process.cwd();
    for (const f of ALLOWLIST) {
      expect(f.endsWith('.ts'), `${f} must be a file, not a directory`).toBe(
        true,
      );
      expect(usesDecrypt(readFileSync(join(root, f), 'utf8')), f).toBe(true);
    }
  });

  it('the reveal service exposes ONE public method (a clear value never leaves without its audit event)', () => {
    // Story 20.4: `verifyStored` used to be public, returned the clear value and slipped past the
    // allowlist above (which only looks at the token `decrypt`). Every other method of the class
    // must be `private` or `#private`; a new public one (e.g. the invoice generator's) is a privacy
    // decision that has to be added here on purpose, together with the event it records.
    const text = stripComments(
      readFileSync(
        join(process.cwd(), 'src', 'crypto', 'id-doc-reveal.service.ts'),
        'utf8',
      ),
    );
    const body = text.slice(text.indexOf('export class IdDocRevealService'));
    const publicMethods = [
      ...body.matchAll(/^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*[(<]/gm),
    ]
      .map((m) => m[1])
      .filter((n) => n !== 'constructor');
    expect(publicMethods).toEqual(['revealOrderIdDoc']);
    expect(body).toMatch(/^ {2}#verifyStored\(/m);
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
