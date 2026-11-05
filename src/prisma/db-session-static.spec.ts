import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

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

const PG_MODULES = new Set(['pg']);
const ADAPTER_MODULES = new Set(['@prisma/adapter-pg']);
const OPTION_IDENTIFIERS = new Set(['withUtcSession', 'sessionOptions']);

type Kind = 'PrismaPg' | 'Client' | 'Pool';

interface Connection {
  line: number;
  text: string;
  safe: boolean;
}

const unwrap = (e: ts.Node): ts.Node => {
  let n = e;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isAwaitExpression(n)
  )
    n = n.expression;
  return n;
};

const stringOf = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? n.text
    : null;

/**
 * Every `new PrismaPg(...)`, `new pg.Client(...)` and `new pg.Pool(...)` in `source`, however the constructor was reached
 * (named import, alias, `import * as`, default import, `require('pg')` inline or through a variable, `createRequire`,
 * `const P = pg.Pool`), read from the TypeScript AST. A connection is `safe` only when its arguments contain a real CALL to
 * `withUtcSession` / `sessionOptions` (or an identifier `SESSION_TIMEZONE_OPTION`): the same text inside a string literal
 * or a comment is not code and does not count.
 */
export function connections(source: string, fileName = 'x.ts'): Connection[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(mjs|cjs|js)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const namespaces = new Set<string>(); // identifiers that hold the whole `pg` module
  const ctors = new Map<string, Kind>([['PrismaPg', 'PrismaPg']]); // identifiers that hold a constructor (the adapter's own name counts even unimported)
  const requirers = new Set<string>(['require']); // functions that load a module by name
  const optionFns = new Set<string>(OPTION_IDENTIFIERS);
  const optionIds = new Set<string>(['SESSION_TIMEZONE_OPTION']);

  const nodes: ts.Node[] = [];
  const collect = (n: ts.Node) => {
    nodes.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const isRequireOf = (e: ts.Node, mods: Set<string>): boolean => {
    const n = unwrap(e);
    if (!ts.isCallExpression(n)) return false;
    const callee = unwrap(n.expression);
    const m = stringOf(n.arguments[0]);
    if (m === null || !mods.has(m)) return false;
    return (
      (ts.isIdentifier(callee) && requirers.has(callee.text)) ||
      callee.kind === ts.SyntaxKind.ImportKeyword
    );
  };

  /** `kind` when `e` evaluates to a constructor we care about. */
  const ctorKind = (e: ts.Node): Kind | null => {
    const n = unwrap(e);
    if (ts.isIdentifier(n)) return ctors.get(n.text) ?? null;
    let name: string | null = null;
    let base: ts.Node | null = null;
    if (ts.isPropertyAccessExpression(n)) {
      name = n.name.text;
      base = n.expression;
    } else if (ts.isElementAccessExpression(n)) {
      name = stringOf(n.argumentExpression);
      base = n.expression;
    }
    if (!name || !base) return null;
    if (name !== 'Pool' && name !== 'Client') return null;
    let root = unwrap(base);
    while (
      (ts.isPropertyAccessExpression(root) && root.name.text === 'default') ||
      (ts.isElementAccessExpression(root) &&
        stringOf(root.argumentExpression) === 'default')
    )
      root = unwrap(root.expression);
    if (ts.isIdentifier(root) && namespaces.has(root.text)) return name;
    if (isRequireOf(root, PG_MODULES)) return name;
    return null;
  };

  // pass 1: imports, createRequire
  for (const n of nodes) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text;
      const bind = n.importClause;
      if (!bind) continue;
      if (PG_MODULES.has(mod)) {
        if (bind.name) namespaces.add(bind.name.text);
        const nb = bind.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb))
          for (const el of nb.elements) {
            const orig = (el.propertyName ?? el.name).text;
            if (orig === 'Pool' || orig === 'Client')
              ctors.set(el.name.text, orig);
            if (orig === 'default') namespaces.add(el.name.text);
          }
      }
      if (ADAPTER_MODULES.has(mod)) {
        if (bind.name) ctors.set(bind.name.text, 'PrismaPg');
        const nb = bind.namedBindings;
        if (nb && ts.isNamedImports(nb))
          for (const el of nb.elements)
            if ((el.propertyName ?? el.name).text === 'PrismaPg')
              ctors.set(el.name.text, 'PrismaPg');
        if (nb && ts.isNamespaceImport(nb))
          namespaces.add(`@adapter:${nb.name.text}`);
      }
      const nb = bind.namedBindings;
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          if ((el.propertyName ?? el.name).text === 'withUtcSession')
            optionFns.add(el.name.text);
    }
  }
  // pass 2 (to a fixpoint): variables
  const adapterNamespaces = () =>
    [...namespaces]
      .filter((x) => x.startsWith('@adapter:'))
      .map((x) => x.slice(9));
  for (let round = 0; round < 4; round++) {
    for (const n of nodes) {
      if (!ts.isVariableDeclaration(n) || !n.initializer) continue;
      const init = unwrap(n.initializer);
      // const require2 = createRequire(...) / module.createRequire(...)
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(n.name) &&
        /createRequire$/.test(init.expression.getText(sf))
      )
        requirers.add(n.name.text);
      // const pg = require('pg')  /  const { Pool: P } = require('pg')
      if (
        isRequireOf(init, PG_MODULES) ||
        (ts.isIdentifier(init) && namespaces.has(init.text))
      ) {
        if (ts.isIdentifier(n.name)) namespaces.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name))
          for (const el of n.name.elements) {
            const orig = (el.propertyName ?? el.name) as ts.Node;
            const o = ts.isIdentifier(orig) ? orig.text : stringOf(orig);
            if ((o === 'Pool' || o === 'Client') && ts.isIdentifier(el.name))
              ctors.set(el.name.text, o);
            if (o === 'default' && ts.isIdentifier(el.name))
              namespaces.add(el.name.text);
          }
      }
      if (isRequireOf(init, ADAPTER_MODULES)) {
        if (ts.isObjectBindingPattern(n.name))
          for (const el of n.name.elements) {
            const orig = (el.propertyName ?? el.name) as ts.Node;
            if (
              ts.isIdentifier(orig) &&
              orig.text === 'PrismaPg' &&
              ts.isIdentifier(el.name)
            )
              ctors.set(el.name.text, 'PrismaPg');
          }
      }
      // const P = pg.Pool / const A = PrismaPg / const A = adapter.PrismaPg
      if (ts.isIdentifier(n.name)) {
        const k = ctorKind(init);
        if (k) ctors.set(n.name.text, k);
        if (
          ts.isPropertyAccessExpression(init) &&
          init.name.text === 'PrismaPg' &&
          ts.isIdentifier(init.expression) &&
          adapterNamespaces().includes(init.expression.text)
        )
          ctors.set(n.name.text, 'PrismaPg');
        if (ts.isIdentifier(init) && namespaces.has(init.text))
          namespaces.add(n.name.text);
      }
    }
  }
  const adapters = adapterNamespaces();
  const kindOfNew = (e: ts.Node): Kind | null => {
    const k = ctorKind(e);
    if (k) return k;
    const n = unwrap(e);
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'PrismaPg' &&
      ts.isIdentifier(unwrap(n.expression)) &&
      adapters.includes((unwrap(n.expression) as ts.Identifier).text)
    )
      return 'PrismaPg';
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'PrismaPg' &&
      isRequireOf(unwrap(n.expression), ADAPTER_MODULES)
    )
      return 'PrismaPg';
    return null;
  };

  const hasOption = (args: readonly ts.Node[]): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const c = unwrap(n.expression);
        if (ts.isIdentifier(c) && optionFns.has(c.text)) found = true;
        if (ts.isPropertyAccessExpression(c) && optionFns.has(c.name.text))
          found = true;
      }
      if (ts.isIdentifier(n) && optionIds.has(n.text)) found = true;
      ts.forEachChild(n, walk);
    };
    args.forEach(walk);
    return found;
  };

  const out: Connection[] = [];
  for (const n of nodes) {
    if (!ts.isNewExpression(n)) continue;
    const kind = kindOfNew(n.expression);
    if (!kind) continue;
    out.push({
      line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      text: `new ${n.expression.getText(sf).replace(/\s+/g, ' ')}(`,
      safe: hasOption(n.arguments ?? []),
    });
  }
  return out;
}

/** Every connection created in `source` WITHOUT the UTC session option: `[line, text]`. */
export function unsafeConnections(
  source: string,
  fileName = 'x.ts',
): [number, string][] {
  return connections(source, fileName)
    .filter((c) => !c.safe)
    .map((c) => [c.line, c.text]);
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
    // the forms that the first (regex) version of this scanner missed
    for (const bad of [
      `import { Pool as P } from 'pg';\nnew P({ connectionString: u });`,
      `import * as x from 'pg';\nnew x.Pool({ connectionString: u });`,
      `const p = new (require('pg').Pool)({ connectionString: u });`,
      `const p = new (require('pg')).Pool({ connectionString: u });`,
      `const p = new (require('pg')['Pool'])({ connectionString: u });`,
      `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nnew (r('pg').Pool)({ connectionString: u });`,
      `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nconst { Client: C } = r('pg');\nnew C({ connectionString: u });`,
      `import { PrismaPg as A } from '@prisma/adapter-pg';\nnew A({ connectionString: u });`,
      `import * as ad from '@prisma/adapter-pg';\nnew ad.PrismaPg({ connectionString: u });`,
      `import pg from 'pg';\nconst P = pg.Pool;\nnew P({ connectionString: u });`,
      `import pg from 'pg';\nconst { Pool: Q } = pg;\nnew Q({});`,
      `const { Pool } = require('pg');\nnew Pool({ connectionString: u });`,
      // the text of the helper inside a literal or a comment is not a call
      `import pg from 'pg';\nnew pg.Pool({ connectionString: 'withUtcSession(x)' });`,
      "import pg from 'pg';\nnew pg.Pool({ connectionString: `withUtcSession(${u})` });",
      `import pg from 'pg';\nnew pg.Pool({ connectionString: u /* withUtcSession(u) */ });`,
      `import pg from 'pg';\nnew pg.Pool({ connectionString: u, application_name: 'sessionOptions(' });`,
    ])
      expect(unsafeConnections(bad), bad).toHaveLength(1);
    // aliases that DO go through the helper are fine
    expect(
      unsafeConnections(
        `import { withUtcSession as w } from './db-session.js';\nimport { Pool as P } from 'pg';\nnew P({ connectionString: w(u) });`,
      ),
    ).toEqual([]);
    expect(
      unsafeConnections(
        `const x = require('pg');\nnew x.Pool({ connectionString: withUtcSession(u) });`,
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
      unsafeConnections(readFileSync(f, 'utf8'), f).map(
        ([line, text]) => `${relative(ROOT, f)}:${line} ${text}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it('the files that do create connections are the ones expected (a new one must be added on purpose)', () => {
    const makers = SCAN.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => {
        return connections(readFileSync(f, 'utf8'), f).length > 0;
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
