import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Story 20.8 round 3: EVERY connection the code opens carries the UTC session option (`withUtcSession`,
 * `src/prisma/db-session.ts`). Round 2 fixed the application and `prisma/seed.ts`, and `prisma/seed-legal.ts` was
 * left behind with a bare `new PrismaPg({ connectionString })`: a seed run against a database in another time zone
 * would have read and written every `timestamptz` shifted. This test reads `src/`, `prisma/` and `scripts/` and
 * fails at the line that creates a `PrismaPg` adapter, a `pg.Client` or a `pg.Pool` whose arguments do not go
 * through `withUtcSession` (or name `SESSION_TIMEZONE_OPTION` / `sessionOptions`).
 * (The e2e helpers under `test/` open their own connections to throw-away databases and are out of scope.)
 */
const ROOT = join(__dirname, '..', '..');
const SCAN = ['src', 'prisma', 'scripts'];
const SKIP_DIRS = new Set(['generated', 'node_modules', 'migrations', 'dist']);
const THIS_FILE = 'db-session-static.spec.ts';
const CODE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(f) ? [] : files(p);
    return CODE_EXT.test(f) && f !== THIS_FILE ? [p] : [];
  });
}

/** Source without comments (a comment may name `new Pool(` without creating one). */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const CREATION = /\bnew\s+(?:PrismaPg|pg\.Client|pg\.Pool)\s*\(/g;
const BARE_PG_CREATION = /\bnew\s+(?:Client|Pool)\s*\(/g;
const OPTION =
  /withUtcSession\s*\(|SESSION_TIMEZONE_OPTION|sessionOptions\s*\(/;
const IMPORTS_PG = /(?:from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\))/;

/** The text between the parenthesis that opens at `open` and its match. */
function argsFrom(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Every connection created in `source` WITHOUT the UTC session option: `[line, text]`. */
export function unsafeConnections(source: string): [number, string][] {
  const src = strip(source);
  const patterns = IMPORTS_PG.test(src)
    ? [CREATION, BARE_PG_CREATION]
    : [CREATION];
  const out: [number, string][] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const open = m.index + m[0].length - 1;
      if (!OPTION.test(argsFrom(src, open))) {
        out.push([
          src.slice(0, m.index).split('\n').length,
          m[0].replace(/\s+/g, ' '),
        ]);
      }
    }
  }
  return out;
}

describe('every database connection opens with the UTC session (Story 20.8 round 3)', () => {
  it('the scanner flags a bare adapter, Client and Pool, and accepts the ones that go through withUtcSession', () => {
    expect(
      unsafeConnections(
        `const a = new PrismaPg({ connectionString: databaseUrl });`,
      ),
    ).toHaveLength(1);
    expect(
      unsafeConnections(
        `import pg from 'pg';\nconst c = new pg.Client({ connectionString: url });`,
      ),
    ).toHaveLength(1);
    expect(
      unsafeConnections(
        `import pg from 'pg';\nconst p = new pg.Pool({\n  connectionString: url.toString(),\n  max: 1,\n});`,
      ),
    ).toHaveLength(1);
    expect(
      unsafeConnections(
        `import { Pool } from 'pg';\nconst p = new Pool({ connectionString: x });`,
      ),
    ).toHaveLength(1);
    expect(
      unsafeConnections(
        `import pg from 'pg';\nconst c = new pg.Client({ connectionString: withUtcSession(url) });\nconst a = new PrismaPg({ connectionString: withUtcSession(a, ['-c x']) });`,
      ),
    ).toEqual([]);
    // a comment that mentions it, or a class called Client of another library, is not a connection
    expect(unsafeConnections(`// new PrismaPg({ x })\nconst a = 1;`)).toEqual(
      [],
    );
    expect(unsafeConnections(`const c = new Client({ x: 1 });`)).toEqual([]);
  });

  it('src/, prisma/ and scripts/: no PrismaPg, pg.Client or pg.Pool without withUtcSession', () => {
    const scanned = SCAN.flatMap((d) => files(join(ROOT, d)));
    expect(scanned.length).toBeGreaterThan(50);
    const bad = scanned.flatMap((f) =>
      unsafeConnections(readFileSync(f, 'utf8')).map(
        ([line, text]) => `${relative(ROOT, f)}:${line} ${text}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it('the files that do create connections are the ones expected (a new one must be added on purpose)', () => {
    const makers = SCAN.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => {
        const s = strip(readFileSync(f, 'utf8'));
        return /\bnew\s+(?:PrismaPg|pg\.Client|pg\.Pool)\s*\(/.test(s);
      })
      .map((f) => relative(ROOT, f))
      .sort();
    expect(makers).toEqual([
      'prisma/seed-legal.ts',
      'prisma/seed.ts',
      'scripts/db-roles.mjs',
      'src/prisma/prisma.service.ts',
      'src/retention/retention-lock.ts',
      'src/usage/usage-log.writer.ts',
    ]);
  });
});
