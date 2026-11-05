import { marginalClock } from '../retention-config.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `anon_carts` (FR-131): anonymous carts (`customerId IS NULL`, the cookie ones) whose `expiresAt` has
 * passed. The `Cart_Items` go with them (`ON DELETE CASCADE`, the ONLY cascade out of `Carts`).
 *
 * Why this cannot hurt a live purchase (checked against the code, not assumed):
 *  - everything that USES an anonymous cart requires `expiresAt > now`: `addItem` (it renews it), the
 *    checkout (`findFirst ... expiresAt > now`) and the login merge (`UPDATE ... WHERE customerId IS
 *    NULL AND expiresAt > now()`). A cart past `expiresAt` is therefore unreachable to all of them;
 *  - the cut-off carries a one-hour safety margin (the application decides `expiresAt > now` with its own
 *    clock), so a cart the application still accepts is never a candidate;
 *  - the rows are picked with `FOR UPDATE SKIP LOCKED` and the `WHERE` is evaluated again on the row
 *    that was locked: a cart a login claimed in the meantime (it sets `customerId`) no longer matches
 *    and is left alone, one held by a transaction is skipped, never waited for. A cart that belongs to
 *    an ACCOUNT is never selected, whatever its date;
 *  - it takes no account lock and no `Customers` row, so the order of 20.6a (customer, then the
 *    advisory lock of the cart) is not involved, and as it never waits for a row it cannot sit in a
 *    wait-for cycle with a checkout, a merge or the anonymization;
 *  - it releases no stock: stock is held by `Stock_Holds` of an order, which this job never touches.
 */
export const anonCartsTask: RetentionTask = {
  name: 'anon_carts',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Carts"
           WHERE "customerId" IS NULL AND "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC')
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Carts" c USING picked WHERE c."id" = picked."id"`,
    );
  },
};

/** `anon_wishlists`: the same rule for `Wishlists` (cascade to `Wishlist_Items`); see `anonCartsTask`. */
export const anonWishlistsTask: RetentionTask = {
  name: 'anon_wishlists',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Wishlists"
           WHERE "customerId" IS NULL AND "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC')
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Wishlists" w USING picked WHERE w."id" = picked."id"`,
    );
  },
};
