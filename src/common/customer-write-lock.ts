import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from './api-exception.js';
import { invalidCustomerTokenException } from './customer-auth.guard.js';
import { isLockWaitExpired } from './lock-timeout.js';

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

/**
 * Story 20.6a: how long a request of an account waits for the lock of its own account. It must stay
 * well below Prisma's default interactive-transaction timeout (5 s): when the wait outlived it, the
 * transaction expired (P2028) and the request answered 500. The wait is bounded IN THE DATABASE
 * (`set_config('lock_timeout', ...)`, transaction-local) and the outcome is ALWAYS the same answer in
 * every route that takes the lock: 409 `ACCOUNT_BUSY`, nothing written, retry in a few seconds.
 */
export const ACCOUNT_LOCK_WAIT_MS = 2_500;

export const accountBusyException = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'ACCOUNT_BUSY',
    'Your account is being used by another operation. Nothing was changed: try again in a few seconds.',
  );

/**
 * Runs `fn` (one or more locking statements of the account) with `lock_timeout` capped at
 * `ACCOUNT_LOCK_WAIT_MS`, then puts back whatever the transaction had (a caller's own `LockBudget`
 * survives). A lock wait that expires is 409 `ACCOUNT_BUSY`.
 */
export async function withAccountLockWait<T>(
  tx: Prisma.TransactionClient,
  fn: () => Promise<T>,
): Promise<T> {
  const cap = `${ACCOUNT_LOCK_WAIT_MS}ms`;
  // The previous value is kept in a transaction-local custom setting and put back afterwards (a
  // caller's own `LockBudget` survives). `$executeRaw` for both: the lock itself stays ONE `$queryRaw`.
  await tx.$executeRaw`SELECT set_config('cc.prev_lock_timeout', current_setting('lock_timeout'), true), set_config('lock_timeout', ${cap}, true)`;
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    if (isLockWaitExpired(err)) throw accountBusyException();
    throw err;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', current_setting('cc.prev_lock_timeout'), true)`;
  return out;
}

/**
 * The advisory lock of the account's cart. Order of every transaction that touches the cart of an
 * account: the Customers row (`lockLiveCustomer`), THEN this lock, then the rows. The checkout takes
 * it too (Story 20.6a): the cart merge writes `Cart_Items` and then UPDATEs the `Carts` row, the
 * checkout DELETEs the `Carts` row (cascade to the lines): without a common lock first the two
 * crossed (40P01).
 */
export async function lockAccountCart(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  await withAccountLockWait(tx, async () => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cart:' + customerId}, 0))`,
    );
  });
}

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
  const row = await withAccountLockWait(tx, () =>
    readCustomerRow(tx, customerId, mode),
  );
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
  const row = await withAccountLockWait(tx, () =>
    readCustomerRow(tx, customerId, mode),
  );
  return row !== null && row.anonymizedAt === null;
}
