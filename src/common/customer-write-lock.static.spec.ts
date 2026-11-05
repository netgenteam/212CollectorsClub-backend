import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.6 (D1): "every write to a table of a customer account takes the Customers row lock and
 * refuses an anonymized account" cannot be forgotten silently. This scans the source for the places that
 * WRITE those tables (Prisma delegates and raw SQL) and pins, file by file, how many times each one
 * calls the lock helper (`src/common/customer-write-lock.ts`). A new writer in a new file fails the
 * first test; a new writer in a known file bumps the count here on purpose (and needs its e2e in
 * `test/customer-account-write-lock.e2e-spec.ts`).
 */
const SRC = join(__dirname, '..');

/**
 * Story 20.6a: the scan runs on the TypeScript AST, not on the text, so it does not care about
 * whitespace, line breaks, quotes, case or how the name is reached:
 *   - `tx.customer.update(`, `tx["customer"].update(`, `tx.customer\n.update(`, `tx['customer']['update'](`;
 *   - nested writes through another model: `order.update({ data: { customer: { update: ... } } })`,
 *     `{ items: { create: ... } }`, `{ addresses: { deleteMany: ... } }`;
 *   - SQL in a string, a template, a concatenation or `$executeRawUnsafe`/`$queryRawUnsafe`, in any case,
 *     with extra whitespace/newlines, `public."Customers"`, `"public"."Customers"` or an unquoted name.
 * What it cannot see (a table name built at run time, a SQL file, a trigger) is stated in the docs.
 */
const DELEGATES = new Set([
  'customer',
  'customerAddress',
  'customerSession',
  'customerAccount',
  'customerVerification',
  'cart',
  'cartItem',
  'wishlist',
  'wishlistItem',
  'consentRecord',
]);
/** Relation names through which another model reaches those tables in a nested write. */
const NESTED_RELATIONS = new Set([
  ...DELEGATES,
  'carts',
  'wishlists',
  'items',
  'addresses',
  'sessions',
  'accounts',
  'verifications',
  'consents',
  'consentRecords',
  'customerAddresses',
]);
const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'connectOrCreate',
  'set',
]);
const TABLES =
  'Customers|Customer_Addresses|Customer_Sessions|Customer_Accounts|Customer_Verifications|Carts|Cart_Items|Wishlists|Wishlist_Items|Consent_Records';
const WRITE_SQL = new RegExp(
  `\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate(?:\\s+table)?|copy)\\s+(?:only\\s+)?(?:"?public"?\\s*\\.\\s*)?"?(${TABLES})"?(?![\\w])`,
  'i',
);
const LOCK_FNS = new Set([
  'lockLiveCustomer',
  'tryLockLiveCustomer',
  'lockCustomerForCheckout',
]);

/** `name` of `x.name`, `x["name"]`, `x['name']` (a non-literal subscript is `null`). */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (
    ts.isElementAccessExpression(n) &&
    (ts.isStringLiteral(n.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(n.argumentExpression))
  ) {
    return n.argumentExpression.text;
  }
  return null;
}
const objectOf = (n: ts.Node): ts.Expression | null =>
  ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)
    ? n.expression
    : null;

/** The text of a string expression, `?` for every part that is not a literal. */
function stringText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return n.text;
  }
  if (ts.isTemplateExpression(n)) {
    return (
      n.head.text + n.templateSpans.map((sp) => '?' + sp.literal.text).join('')
    );
  }
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = stringText(n.left);
    const r = stringText(n.right);
    if (l === null && r === null) return null;
    return (l ?? '?') + (r ?? '?');
  }
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) {
    return stringText(n.expression);
  }
  if (ts.isTaggedTemplateExpression(n)) return stringText(n.template);
  return null;
}

interface Scan {
  writes: string[];
  locks: number;
  sql: string[];
}

function scan(text: string, rel: string): Scan {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: Scan = { writes: [], locks: 0, sql: [] };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // lock helper
      if (ts.isIdentifier(callee) && LOCK_FNS.has(callee.text)) out.locks += 1;
      // <anything>.<delegate>.<op>(...)
      const op = memberName(callee);
      const holder = objectOf(callee);
      if (op !== null && WRITE_OPS.has(op) && holder !== null) {
        const d = memberName(holder);
        if (d !== null && DELEGATES.has(d)) out.writes.push(`${d}.${op}`);
      }
    }
    // nested write: { customer: { update: ... } }
    if (
      ts.isPropertyAssignment(n) &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      const key =
        ts.isIdentifier(n.name) ||
        ts.isStringLiteral(n.name) ||
        ts.isNoSubstitutionTemplateLiteral(n.name)
          ? n.name.text
          : null;
      if (key !== null && NESTED_RELATIONS.has(key)) {
        for (const p of n.initializer.properties) {
          const k =
            p.name !== undefined &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
              ? p.name.text
              : null;
          if (k !== null && WRITE_OPS.has(k))
            out.writes.push(`nested ${key}.${k}`);
        }
      }
    }
    // SQL in any string expression: take it from its maximal node only
    const t = stringText(n);
    if (t !== null && !(n.parent && stringText(n.parent) !== null)) {
      if (WRITE_SQL.test(t)) out.sql.push(t.replace(/\s+/g, ' ').slice(0, 80));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Entry = { locks: number } | { exempt: string; mustContain: RegExp };

/** file (relative to src/) -> how it is covered. */
const WRITERS: Record<string, Entry> = {
  // PATCH /auth/me, resend-verification / register token, register consent.
  'customer-auth/customer-auth.service.ts': { locks: 3 },
  // POST/PATCH/DELETE /auth/addresses (the shared `runLocked`).
  'customer-addresses/customer-addresses.service.ts': { locks: 1 },
  // POST/PATCH/DELETE /cart/items of an account + the merge at login.
  'cart/cart.service.ts': { locks: 4 },
  // POST/DELETE /wishlist/items of an account + the merge at login.
  'wishlist/wishlist.service.ts': { locks: 3 },
  // POST /me/consent.
  'legal/consent.service.ts': { locks: 1 },
  // POST /admin/customers/verify-email.
  'admin-customers/admin-customers.service.ts': { locks: 1 },
  // Checkout: FOR SHARE as the first statement (Story 20.4).
  'checkout/checkout.service.ts': { locks: 1 },
  // The anonymization itself holds the FOR UPDATE.
  'admin-customers/customer-anonymization.service.ts': {
    exempt: 'it is the FOR UPDATE side of the lock',
    mustContain:
      /FROM "Customers" WHERE "id" = \$\{customerId\}::uuid FOR UPDATE/,
  },
  // Helper that only deletes what it can prove belongs to an ANONYMIZED account (EXISTS ...) is in
  // customer-auth.service.ts (counted above).
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'generated') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const files = walk(SRC).map((f) => {
  const rel = relative(SRC, f).split('\\').join('/');
  const text = readFileSync(f, 'utf8');
  return { rel, text: stripComments(text), scan: scan(text, rel) };
});

describe('customer account writes take the Customers row lock (Story 20.6, D1)', () => {
  it('every file that writes a table of the account is registered here', () => {
    const writers = files
      .filter((f) => f.scan.writes.length > 0 || f.scan.sql.length > 0)
      .map((f) => f.rel)
      .sort();
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  for (const [rel, entry] of Object.entries(WRITERS)) {
    it(`${rel} ${'locks' in entry ? `calls the lock helper ${entry.locks} time(s)` : 'is exempt: ' + entry.exempt}`, () => {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} exists`).toBeDefined();
      if ('locks' in entry) {
        expect(f!.scan.locks).toBe(entry.locks);
      } else {
        expect(f!.text).toMatch(entry.mustContain);
      }
    });
  }

  it('the helper checks anonymizedAt and is the only FOR SHARE/UPDATE of "Customers" outside the anonymization', () => {
    const helper = files.find(
      (f) => f.rel === 'common/customer-write-lock.ts',
    )!;
    expect(helper.text).toMatch(/anonymizedAt/);
    expect(helper.text).toMatch(/FOR SHARE/);
    expect(helper.text).toMatch(/FOR UPDATE/);
    const others = files.filter(
      (f) =>
        f.rel !== 'common/customer-write-lock.ts' &&
        f.rel !== 'admin-customers/customer-anonymization.service.ts' &&
        /FROM\s+"Customers"[^`;]*?FOR\s+(SHARE|UPDATE|NO\s+KEY\s+UPDATE)/i.test(
          f.text,
        ),
    );
    expect(others.map((f) => f.rel)).toEqual([]);
  });

  it('Story 20.6a: the only FOR KEY SHARE of "Customers" is the credential writers of customer-auth (reset/forgot)', () => {
    const keyShare = files.filter((f) =>
      /FROM\s+"Customers"[^`;]*?FOR\s+KEY\s+SHARE/i.test(f.text),
    );
    expect(keyShare.map((f) => f.rel)).toEqual([
      'customer-auth/customer-auth.service.ts',
    ]);
  });
});

/**
 * Story 20.6a: the scanner itself. Each of these writes to an account table in a way the previous,
 * text-based scan let through; every one must be seen.
 */
describe('the scanner sees the writes the text scan missed (Story 20.6a)', () => {
  const sees = (code: string) => {
    const r = scan(code, 'x.ts');
    return r.writes.length + r.sql.length > 0;
  };
  it.each([
    [
      'tx["customer"].update(...)',
      'await tx["customer"].update({ where: { id } });',
    ],
    [
      "tx['customerAddress']['deleteMany']",
      "await tx['customerAddress']['deleteMany']({});",
    ],
    ['chain over two lines', 'await tx.customer\n    .update({ data: {} });'],
    [
      'dot on the next line',
      'await this.prisma\n  .cart\n  .delete({ where: { id } });',
    ],
    [
      'lower-case SQL',
      'await tx.$executeRaw`update "customers" set x = 1`; await tx.$executeRaw`delete   from\n "Carts" where 1=1`;',
    ],
    [
      'public-qualified table',
      'await tx.$executeRaw`UPDATE public."Customers" SET "name" = 1`;',
    ],
    [
      '"public"."Customers"',
      'await tx.$executeRaw`UPDATE "public"."Customers" SET "name" = 1`;',
    ],
    [
      '$executeRawUnsafe',
      'await prisma.$executeRawUnsafe(\'DELETE FROM "Wishlists" WHERE 1=1\');',
    ],
    [
      '$queryRawUnsafe with a concatenation',
      'await prisma.$queryRawUnsafe("INSERT INTO " + \'"Cart_Items"\' + " VALUES (1)");',
    ],
    [
      'SQL in a template with a hole',
      'const t = "Customers"; await tx.$executeRaw(Prisma.sql`UPDATE "Customers" SET "phone" = ${p}`);',
    ],
    [
      'nested update through order',
      'await tx.order.update({ where: { id }, data: { customer: { update: { name: "x" } } } });',
    ],
    [
      'nested create of lines of a cart',
      'await tx.something.update({ data: { items: { create: [{ a: 1 }] } } });',
    ],
    [
      'nested deleteMany of addresses',
      'await tx.x.update({ data: { addresses: { deleteMany: {} } } });',
    ],
  ])('%s', (_n, code) => {
    expect(sees(code)).toBe(true);
  });

  it.each([
    ['a read', 'await tx.customer.findUnique({ where: { id } });'],
    [
      'a select',
      'await tx.$queryRaw`SELECT * FROM "Customers" WHERE id = ${id}`;',
    ],
    ['another table', 'await tx.$executeRaw`UPDATE "Products" SET stock = 1`;'],
    [
      'a comment',
      '// await tx.customer.update({}); UPDATE "Customers"\n/* DELETE FROM "Carts" */',
    ],
    [
      'a word that merely contains the name',
      'await tx.$executeRaw`UPDATE "Customers_Archive" SET x = 1`;',
    ],
  ])('does not flag %s', (_n, code) => {
    expect(sees(code)).toBe(false);
  });

  it('counts the lock calls', () => {
    expect(
      scan(
        'await lockLiveCustomer(tx, id); await tryLockLiveCustomer(tx, id, "UPDATE");',
        'x.ts',
      ).locks,
    ).toBe(2);
  });
});
