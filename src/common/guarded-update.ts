import { Prisma } from '../generated/prisma/client.js';

/**
 * Story 4.1 (AD-16): the codebase's single reusable primitive for a
 * *guarded conditional update* — a raw, parameterized `UPDATE ... WHERE
 * <guard>` (built with `Prisma.sql`, the exact same parameterized-raw-SQL
 * style Story 3.2 established for `Cart_Items`' stock guard) executed
 * inside the caller's own transaction, returning how many rows it actually
 * affected.
 *
 * This function is deliberately generic/thin — it does not know or care
 * *what* is being guarded. Every guarded-conditional-write in this codebase
 * goes through it:
 *
 * - **Product stock guards** (AD-6 stock-hold creation here in
 *   `CheckoutService`, AD-13 stock decrement in future Order-confirmation
 *   stories) — guard is `stock - "heldQty" >= qty` or similar.
 * - **Order status transition guards** (AD-7/AD-16) — guard is `status =
 *   <expected-prior-status>`. See `order-status-transition.ts` in this same
 *   folder, which wraps this primitive with the Order-specific "0 rows
 *   affected -> throw a typed conflict, else also write the
 *   OrderStatusHistory row" behavior that Stories 4.3, 5.2, 9.2 and 9.3
 *   all reuse instead of re-deriving it.
 *
 * The caller always decides what "0 rows affected" *means* for their
 * specific guard (insufficient stock vs. a stale Order status vs. anything
 * else future stories guard this way) — this function only ever reports
 * the raw affected-row count, never throws on 0 itself.
 */
export async function executeGuardedUpdate(
  tx: Prisma.TransactionClient,
  sql: Prisma.Sql,
): Promise<number> {
  return tx.$executeRaw(sql);
}
