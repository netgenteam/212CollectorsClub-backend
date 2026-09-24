import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { executeGuardedUpdate } from './guarded-update.js';

/**
 * Story 4.1 (AD-7, AD-16): thrown by `guardedOrderStatusTransition` when its
 * guarded `UPDATE "Orders" SET status=... WHERE id=? AND status=<expected
 * prior>` affects 0 rows — meaning the Order was no longer in the status
 * the caller expected (someone/something else already moved it: a racing
 * admin click, a cron expiry racing an admin confirm, etc., per AD-16).
 * A generic `Error` subclass rather than an `ApiException` on purpose: this
 * module lives in `common/` and is reused by Order-transition call sites in
 * several future modules/stories (4.3 PayPal outcome, 5.2 stock-hold expiry
 * cron, 9.2 admin confirm/reject, 9.3 admin fulfillment status) that may
 * each want a different HTTP status/errorCode for the same underlying
 * conflict (e.g. a cron job doesn't have an HTTP response to shape at all).
 * Each call site catches this and translates it into whatever response
 * shape fits its own endpoint.
 */
export class OrderTransitionConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly expectedFromStatus: OrderStatus,
  ) {
    super(
      `Order ${orderId} is no longer in status ${expectedFromStatus} — the transition target is stale.`,
    );
    this.name = 'OrderTransitionConflictError';
  }
}

interface OrderActorParams {
  actorType: OrderActorType;
  /** Set only when `actorType = ADMIN` (see OrderActorType's doc comment
   * in schema.prisma for why this has no FK yet). */
  adminUserId?: string | null;
}

export interface RecordInitialOrderStatusParams extends OrderActorParams {
  orderId: string;
  toStatus: OrderStatus;
}

/**
 * Writes the very first `OrderStatusHistory` row for an Order that was
 * just created in this same transaction (`fromStatus = null`, per AD-7 —
 * there is no prior state to guard against on a fresh INSERT, so this is
 * deliberately NOT a guarded update, unlike `guardedOrderStatusTransition`
 * below). Story 4.1 uses this for `[]->pending_verification`; Story 4.3
 * will reuse it unchanged for `[]->payment_processing`.
 */
export async function recordInitialOrderStatus(
  tx: Prisma.TransactionClient,
  params: RecordInitialOrderStatusParams,
): Promise<void> {
  await tx.orderStatusHistory.create({
    data: {
      orderId: params.orderId,
      fromStatus: null,
      toStatus: params.toStatus,
      actorType: params.actorType,
      adminUserId: params.adminUserId ?? null,
    },
  });
}

export interface GuardedOrderStatusTransitionParams extends OrderActorParams {
  orderId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
}

/**
 * AD-16's guarded-conditional-update pattern, specialized for Order status
 * transitions and packaged for reuse by every later order-transition story
 * (4.3, 5.2, 9.2, 9.3) instead of each one hand-rolling its own copy:
 *
 * 1. Runs a guarded raw `UPDATE "Orders" SET status=<toStatus> WHERE
 *    id=<orderId> AND status=<fromStatus>` via `executeGuardedUpdate` (the
 *    shared AD-16 primitive in `guarded-update.ts`) inside the CALLER's own
 *    transaction — so this call always shares the same DB transaction as
 *    whatever stock/hold mutation (AD-6/AD-13) the caller is also making,
 *    exactly as AD-16 requires.
 * 2. Zero affected rows -> throws `OrderTransitionConflictError` (the
 *    Order's status was already something other than `fromStatus`) — the
 *    caller's own transaction then rolls back as a whole, so no history
 *    row and no side effect (stock decrement, hold release, etc.) is ever
 *    partially applied.
 * 3. Exactly one affected row -> writes the `OrderStatusHistory` row for
 *    this transition in the SAME transaction, so the guarded status change
 *    and its audit trail entry can never end up out of sync.
 *
 * Story 4.1 does not call this itself (its own `[]->pending_verification`
 * transition is a fresh INSERT via `recordInitialOrderStatus` above, not an
 * UPDATE on an existing row) — it is introduced here, tested here, and
 * left ready for the first real caller (Story 4.3's PayPal
 * payment_processing->{paid,payment_failed} transition).
 */
export async function guardedOrderStatusTransition(
  tx: Prisma.TransactionClient,
  params: GuardedOrderStatusTransitionParams,
): Promise<void> {
  const affected = await executeGuardedUpdate(
    tx,
    Prisma.sql`
      UPDATE "Orders"
      SET status = ${params.toStatus}::"OrderStatus", "updatedAt" = now()
      WHERE id = ${params.orderId}::uuid
        AND status = ${params.fromStatus}::"OrderStatus"
    `,
  );

  if (affected === 0) {
    throw new OrderTransitionConflictError(params.orderId, params.fromStatus);
  }

  await tx.orderStatusHistory.create({
    data: {
      orderId: params.orderId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      actorType: params.actorType,
      adminUserId: params.adminUserId ?? null,
    },
  });
}
