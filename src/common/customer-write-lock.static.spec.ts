import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const DELEGATES =
  'customer|customerAddress|customerSession|customerAccount|customerVerification|cart|cartItem|wishlist|wishlistItem|consentRecord';
const WRITE_DELEGATE = new RegExp(
  `\\.(${DELEGATES})\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`,
);
const TABLES =
  'Customers|Customer_Addresses|Customer_Sessions|Customer_Accounts|Customer_Verifications|Carts|Cart_Items|Wishlists|Wishlist_Items|Consent_Records';
const WRITE_SQL = new RegExp(
  `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"(${TABLES})"`,
);
const LOCK_CALL =
  /\b(lockLiveCustomer|tryLockLiveCustomer|lockCustomerForCheckout)\(/g;

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

const files = walk(SRC).map((f) => ({
  rel: relative(SRC, f).split('\\').join('/'),
  text: stripComments(readFileSync(f, 'utf8')),
}));

describe('customer account writes take the Customers row lock (Story 20.6, D1)', () => {
  it('every file that writes a table of the account is registered here', () => {
    const writers = files
      .filter((f) => WRITE_DELEGATE.test(f.text) || WRITE_SQL.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  for (const [rel, entry] of Object.entries(WRITERS)) {
    it(`${rel} ${'locks' in entry ? `calls the lock helper ${entry.locks} time(s)` : 'is exempt: ' + entry.exempt}`, () => {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} exists`).toBeDefined();
      if ('locks' in entry) {
        const n = (f!.text.match(LOCK_CALL) ?? []).length;
        expect(n).toBe(entry.locks);
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
        /FROM "Customers"[^`]*FOR (SHARE|UPDATE)/.test(f.text),
    );
    expect(others.map((f) => f.rel)).toEqual([]);
  });
});
