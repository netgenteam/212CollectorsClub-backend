import type { Prisma } from '../generated/prisma/client.js';
import { invalidCustomerTokenException } from './customer-auth.guard.js';

/**
 * Story 20.6 (AD-97/98): THE serialization point of every write to the data of a customer account.
 *
 * The anonymization (`CustomerAnonymizationService`) takes `SELECT ... FROM "Customers" WHERE id = $1
 * FOR UPDATE` and then deletes the person's data. A request that is already past its guard (a
 * session read before the commit) would otherwise write AFTER the anonymization and leave a name, a
 * phone, an address, a cart or a wishlist on an anonymized account. So every transaction that writes a
 * table of the account runs, as its FIRST statement,
 *
 *   SELECT "anonymizedAt" FROM "Customers" WHERE id = $1 FOR SHARE   (or FOR UPDATE, see below)
 *
 * which conflicts with the `FOR UPDATE` of the anonymization: the writer either gets the lock first
 * (and the anonymization waits for it, then deletes what it wrote) or waits, then sees
 * `anonymizedAt` and answers 401 without writing anything.
 *
 * Lock order (no deadlock): the Customers row FIRST, then everything else (advisory lock of the
 * cart / wishlist / verification, address rows, ...); the audit chain lock is always last (AD-99).
 * The anonymization takes the Customers row first too.
 *
 * `SHARE` for writers that do not change the Customers row itself; `UPDATE` when the same
 * transaction is going to UPDATE that row (profile) or wants the address book serialized per
 * customer (two `FOR SHARE` holders that both upgrade would deadlock each other).
 *
 * Only the routes of an account call this: guest carts and wishlists (no `customerId`) never do and
 * are not affected. `test/customer-write-lock.static.spec.ts` fails if a file that writes a table of
 * the account does not call one of these helpers.
 */
export type CustomerLockMode = 'SHARE' | 'UPDATE';

async function readCustomerRow(
  tx: Prisma.TransactionClient,
  customerId: string,
  mode: CustomerLockMode,
): Promise<{ anonymizedAt: Date | null } | null> {
  const rows =
    mode === 'UPDATE'
      ? await tx.$queryRaw<
          { anonymizedAt: Date | null }[]
        >`SELECT "anonymizedAt" FROM "Customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`
      : await tx.$queryRaw<
          { anonymizedAt: Date | null }[]
        >`SELECT "anonymizedAt" FROM "Customers" WHERE "id" = ${customerId}::uuid FOR SHARE`;
  return rows[0] ?? null;
}

/** First statement of the transaction; 401 `INVALID_CUSTOMER_TOKEN` for a gone or anonymized account. */
export async function lockLiveCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  mode: CustomerLockMode = 'SHARE',
): Promise<void> {
  const row = await readCustomerRow(tx, customerId, mode);
  if (!row || row.anonymizedAt !== null) {
    throw invalidCustomerTokenException();
  }
}

/** Same lock, but answers `false` (instead of throwing) for a gone or anonymized account. */
export async function tryLockLiveCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  mode: CustomerLockMode = 'SHARE',
): Promise<boolean> {
  const row = await readCustomerRow(tx, customerId, mode);
  return row !== null && row.anonymizedAt === null;
}
