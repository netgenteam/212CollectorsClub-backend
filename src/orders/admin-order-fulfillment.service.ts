import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../common/order-status-transition.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';
import { AdminFulfillmentDecisionResponseDto } from './dto/admin-fulfillment-decision-response.dto.js';

function orderNotFoundException(orderId: string): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'ORDER_NOT_FOUND',
    `No Order exists with id "${orderId}".`,
  );
}

/**
 * Story 9.3 (AD-7, AD-16). Thrown INSIDE `cancelOrder`'s transaction when
 * the compensating `UPDATE "Products" SET stock = stock + qty WHERE id = ?`
 * for one `OrderLine` affects 0 rows — meaning that row's `productId` no
 * longer resolves to an existing `Products` row.
 *
 * **Why this UPDATE is still routed through `executeGuardedUpdate` even
 * though a plain increment has no lower-bound invariant to protect** (unlike
 * AD-6/AD-13's decrement guards, `stock = stock + qty` can never itself
 * fail/overflow under realistic concurrency — two concurrent cancels of the
 * same Order can't happen per AD-7 in the first place, since the SECOND one
 * always loses `guardedOrderStatusTransition`'s own `paid` guard first and
 * the whole transaction never reaches this loop): consistency with AD-16 —
 * every stock-mutating UPDATE in this codebase (Story 4.1's hold creation,
 * 4.3/5.2/9.2's decrements/releases) reports its affected-row count through
 * this SAME primitive and treats 0 as a typed, transaction-aborting
 * conflict rather than trusting a plain `prisma.product.update` to silently
 * no-op against a row that no longer exists. In today's schema this is
 * practically unreachable in normal operation — `OrderLine.product` has no
 * `onDelete: Cascade`/`SetNull` (defaults to `Restrict`), so a `Product`
 * referenced by any `OrderLine` cannot be hard-deleted at the DB level at
 * all (AD-2's "deactivate, never hard-delete when referenced" policy,
 * enforced structurally here, not just by convention) — but the guard
 * costs nothing and closes the theoretical gap defensively rather than
 * assuming a FK invariant is bulletproof against every future migration.
 */
class StockReincrementConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(
      `Order ${orderId}: compensating stock re-increment UPDATE for Product ${productId} affected 0 rows.`,
    );
    this.name = 'StockReincrementConflictError';
  }
}

/**
 * Story 9.3 (FR-27, NFR-4, NFR-6; AD-7, AD-16). The Admin-facing fulfillment
 * side of Order lifecycle management — a sibling to `AdminOrderPaymentService`
 * (Story 9.2's confirm/reject), kept in its own class/file for the same
 * read/write-per-concern split this module already follows
 * (`AdminOrdersService` read-only / `AdminOrderPaymentService` payment
 * mutations / `OrderLookupService` buyer-facing reads / this class:
 * post-payment fulfillment mutations), all wired into the SAME
 * `AdminOrdersController` (AD-14: one module, one controller for §4.9 admin
 * order/payment management — no new module).
 *
 * **Reuses, never reinvents**: both `fulfillOrder`/`cancelOrder` transition
 * through `guardedOrderStatusTransition` (Story 4.1's helper), the exact
 * same primitive Stories 4.3/5.2/9.2 already use — this is its 6th/7th real
 * call site. `cancelOrder`'s compensating stock re-increment goes through
 * `executeGuardedUpdate` (the shared AD-16 primitive), for the reasoning in
 * `StockReincrementConflictError`'s own doc comment above. Both guarded
 * transitions write `actorType = ADMIN` with `adminUserId` set, same as
 * Story 9.2's two decision endpoints.
 *
 * **AC3 — an illegal/duplicate transition is an explicit conflict, never a
 * silent no-op**: exactly Story 9.2's own AC4 criterion, reapplied here.
 * `fulfill`/`cancel` are live, interactive Admin HTTP requests with a caller
 * waiting on a useful answer — unlike Story 4.3's PayPal webhook or Story
 * 5.2's crons (no live caller, so those two swallow
 * `OrderTransitionConflictError` into a safe 200/no-op instead, see their
 * own doc comments) — so `translateTransitionError` below always turns a
 * stale/duplicate/illegal transition into a real 409 `ORDER_NOT_PAID`,
 * including the Order's actual current status, and NEVER silently changes
 * (or fails to change) the Order's state.
 *
 * **No stock touch on fulfill**: `fulfillOrder` is a pure status transition.
 * `Product.stock` was already decremented once, permanently, at payment
 * confirmation time (4.3's PayPal capture / 9.2's Pago Móvil confirm) — a
 * fulfilled Order does not "sell" anything a second time, so there is
 * nothing to guard or mutate here beyond the Order row itself.
 */
@Injectable()
export class AdminOrderFulfillmentService {
  private readonly logger = new Logger(AdminOrderFulfillmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 9.3 AC1 (AD-7, AD-16). One transaction, one guarded UPDATE:
   * `paid -> fulfilled` (terminal). Zero affected rows (Order no longer
   * `paid`) throws `OrderTransitionConflictError`, translated below into
   * AC3's explicit 409 before anything else runs.
   */
  async fulfillOrder(
    orderId: string,
    admin: AuthenticatedAdminUser,
  ): Promise<AdminFulfillmentDecisionResponseDto> {
    await this.assertOrderExists(orderId);

    try {
      await this.prisma.$transaction(async (tx) => {
        await guardedOrderStatusTransition(tx, {
          orderId,
          fromStatus: OrderStatus.PAID,
          toStatus: OrderStatus.FULFILLED,
          actorType: OrderActorType.ADMIN,
          adminUserId: admin.id,
        });
      });
    } catch (err) {
      await this.translateTransitionError(err, orderId);
    }

    this.logger.log(
      `Order ${orderId} marked FULFILLED by admin ${admin.id} — no stock touched (already decremented at payment confirmation).`,
    );
    return this.toDecisionDto(orderId);
  }

  /**
   * Story 9.3 AC2 (AD-7, AD-16). One transaction:
   * 1. `guardedOrderStatusTransition` `paid -> cancelled` (terminal) — 0
   *    rows affected (Order no longer `paid`) throws
   *    `OrderTransitionConflictError`, caught below and turned into AC3's
   *    explicit 409, before any stock is touched.
   * 2. Every `OrderLine` for this Order (re-selected inside this same
   *    transaction — the snapshot quantity purchased, never re-derived from
   *    the current Cart/Product) gets its purchased quantity given back to
   *    `Product.stock` via the guarded `UPDATE "Products" SET stock = stock
   *    + qty WHERE id = ?`. Zero affected rows on ANY line throws
   *    `StockReincrementConflictError`, rolling back everything already
   *    done in this transaction (including step 1's transition) — never a
   *    partial re-increment across a multi-line Order.
   */
  async cancelOrder(
    orderId: string,
    admin: AuthenticatedAdminUser,
  ): Promise<AdminFulfillmentDecisionResponseDto> {
    await this.assertOrderExists(orderId);

    try {
      await this.prisma.$transaction(async (tx) => {
        await guardedOrderStatusTransition(tx, {
          orderId,
          fromStatus: OrderStatus.PAID,
          toStatus: OrderStatus.CANCELLED,
          actorType: OrderActorType.ADMIN,
          adminUserId: admin.id,
        });

        const lines = await tx.orderLine.findMany({
          where: { orderId },
          select: { productId: true, quantity: true },
        });

        for (const line of lines) {
          const affected = await executeGuardedUpdate(
            tx,
            Prisma.sql`
              UPDATE "Products"
              SET stock = stock + ${line.quantity}
              WHERE id = ${line.productId}::uuid
            `,
          );
          if (affected === 0) {
            throw new StockReincrementConflictError(orderId, line.productId);
          }
        }
      });
    } catch (err) {
      await this.translateTransitionError(err, orderId);
    }

    this.logger.log(
      `Order ${orderId} CANCELLED by admin ${admin.id} — stock re-incremented for every OrderLine in the same transaction.`,
    );
    return this.toDecisionDto(orderId);
  }

  private async assertOrderExists(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw orderNotFoundException(orderId);
    }
  }

  /**
   * Translates this class's own guarded-transaction conflicts into the
   * API's usual `ApiException` shape — same pattern as
   * `AdminOrderPaymentService.translateDecisionError`. Anything else
   * (a genuinely unexpected error) is rethrown unchanged.
   *
   * AC3's "current status of the Order" detail: re-reads the Order's
   * NOW-current status (outside the failed transaction, which already
   * rolled back) so the 409 body can tell the Admin what it actually is —
   * a courtesy for the Admin UI; the guarded UPDATE itself is what actually
   * prevented the illegal/duplicate action.
   */
  private async translateTransitionError(
    err: unknown,
    orderId: string,
  ): Promise<never> {
    if (err instanceof OrderTransitionConflictError) {
      const current = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      throw new ApiException(
        HttpStatus.CONFLICT,
        'ORDER_NOT_PAID',
        `Order ${orderId} is not currently paid (still pending verification, or already fulfilled/cancelled/etc.) — this action cannot be applied.`,
        { currentStatus: current ? current.status.toLowerCase() : 'unknown' },
      );
    }
    if (err instanceof StockReincrementConflictError) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'STOCK_REINCREMENT_CONFLICT',
        `Failed to re-increment stock for Product ${err.productId} on Order ${orderId} — the cancellation was aborted and the Order remains paid.`,
        { productId: err.productId },
      );
    }
    throw err;
  }

  private async toDecisionDto(
    orderId: string,
  ): Promise<AdminFulfillmentDecisionResponseDto> {
    // Re-read post-commit rather than trust a locally-built Date: this is
    // what makes `updatedAt` agree exactly with the `Order.updatedAt` the
    // guarded transition itself just set (`now()`, server-side) and with
    // the OrderStatusHistory row it wrote alongside it.
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, updatedAt: true },
    });
    return {
      orderId,
      status: order.status.toLowerCase(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}
