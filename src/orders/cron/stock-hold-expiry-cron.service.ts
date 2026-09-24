import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../../generated/prisma/enums.js';
import { executeGuardedUpdate } from '../../common/guarded-update.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../../common/order-status-transition.js';

/**
 * Story 5.2 (AD-6): thrown when the guarded `heldQty` release UPDATE
 * (`WHERE "heldQty" >= quantity`) affects 0 rows while releasing an
 * expired `StockHold`. Under this codebase's current writers, this should
 * never actually happen: checkout (Story 4.1) only ever INCREMENTS
 * `heldQty`, and this cron is the only place that decrements it — guarded
 * by `StockHold.releasedAt IS NULL` at the candidate-selection query, so
 * the exact same hold row is never processed twice, even across
 * overlapping/duplicate cron runs. Kept as an explicit, typed guard anyway
 * (never a blind decrement) in case a future writer (e.g. Story 8.3's
 * admin direct-stock-adjustment tool) ever touches `heldQty` too — same
 * defensive posture `StockDecrementConflictError` already establishes in
 * `PaypalPaymentsService` for the analogous `stock` guard.
 *
 * Thrown INSIDE the per-order transaction, so it aborts that transaction
 * as a whole — the Order's `->expired` transition rolls back right along
 * with the failed release, per this story's core invariant ("a lapsed
 * hold and a still-pending Order can never coexist" cuts both ways: never
 * leave a half-released hold on an already-expired Order either). The
 * Order stays `pending_verification` and is simply retried on the next
 * cron run; the caller logs this loudly for manual reconciliation in the
 * meantime.
 */
export class HeldQtyReleaseConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
    public readonly stockHoldId: string,
  ) {
    super(
      `Order ${orderId}: guarded heldQty release for Product ${productId} (StockHold ${stockHoldId}) affected 0 rows.`,
    );
    this.name = 'HeldQtyReleaseConflictError';
  }
}

export interface StockHoldExpiryCheckResult {
  /** Orders successfully transitioned pending_verification -> expired,
   * with every one of their expired holds released. */
  ordersExpired: number;
  /** Orders whose candidate StockHold(s) were already stale by the time
   * this ran — the guarded transition's WHERE matched 0 rows because the
   * Order already left pending_verification (admin resolved it, or a
   * previous/overlapping cron run already expired it). Safe no-op. */
  ordersSkippedConflict: number;
  /** Orders where the Order transition itself succeeded but releasing one
   * of its holds hit `HeldQtyReleaseConflictError` — the whole per-order
   * transaction was rolled back (Order remains pending_verification), and
   * this is flagged for manual reconciliation. Should be 0 in practice —
   * see that error's own doc comment. */
  ordersFlaggedForReconciliation: number;
}

/**
 * Story 5.2 (AD-6, AD-7, AD-16): releases every `StockHold` whose
 * `expiresAt` has passed for an Order still sitting in
 * `pending_verification` (a Pago Móvil checkout the buyer never finished
 * paying/uploading proof for within the 24h window), atomically alongside
 * that Order's `->expired` transition.
 *
 * **Testable without the real 5-minute interval**: the `@Cron`-decorated
 * `handleCron` below is a thin trigger that does nothing but call
 * `runExpiryCheck`, the actual public method that does all the work and
 * returns a summary. Tests (unit and e2e) call `runExpiryCheck()`
 * directly — never wait for `@nestjs/schedule` to fire it, and never
 * touch `handleCron` at all.
 *
 * **Reuses, never reimplements, Story 4.1's guarded-transition helper**:
 * every Order status change goes through `guardedOrderStatusTransition`
 * (`src/common/order-status-transition.ts`), exactly like
 * `PaypalPaymentsService` (Story 4.3) already does. The `heldQty` release
 * itself reuses the same generic `executeGuardedUpdate` (AD-16) primitive
 * `CheckoutService` already uses for the opposite (increment) direction.
 *
 * **One DB transaction per Order, not one giant transaction for the whole
 * batch**: a 5-minute sweep could in principle find many expired Orders;
 * processing each in its own short transaction keeps lock scope minimal
 * (mirrors `PaypalPaymentsService`'s per-webhook transaction, one Order at
 * a time) and means one Order's conflict/failure never blocks or rolls
 * back another's otherwise-successful expiry.
 */
@Injectable()
export class StockHoldExpiryCronService {
  private readonly logger = new Logger(StockHoldExpiryCronService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'stock-hold-expiry' })
  async handleCron(): Promise<void> {
    await this.runExpiryCheck();
  }

  async runExpiryCheck(): Promise<StockHoldExpiryCheckResult> {
    const now = new Date();

    // --- Candidate selection only — an efficient pre-filter, NOT the
    // correctness guarantee. `guardedOrderStatusTransition`'s own WHERE
    // status=pending_verification guard (run per-order, inside its own
    // transaction below) is what actually decides whether a given Order
    // is safe to expire; this query only narrows down which Orders are
    // even worth opening a transaction for, so a candidate that turns out
    // stale by the time its transaction runs is simply skipped there —
    // never a correctness issue, only a wasted (harmless) transaction.
    const expiredHolds = await this.prisma.stockHold.findMany({
      where: {
        releasedAt: null,
        expiresAt: { lte: now },
        order: { status: OrderStatus.PENDING_VERIFICATION },
      },
      select: { orderId: true },
    });
    const candidateOrderIds = [
      ...new Set(expiredHolds.map((hold) => hold.orderId)),
    ];

    let ordersExpired = 0;
    let ordersSkippedConflict = 0;
    let ordersFlaggedForReconciliation = 0;

    for (const orderId of candidateOrderIds) {
      try {
        await this.expireOneOrder(orderId, now);
        ordersExpired++;
      } catch (err) {
        if (err instanceof OrderTransitionConflictError) {
          // AC3: the Order already left pending_verification (admin
          // resolved it, or a previous/overlapping cron run already won
          // this same Order) between the candidate query above and this
          // transaction — safe skip: no history duplicated, no
          // heldQty touched, no resurrection of a terminal state.
          this.logger.log(
            `StockHold expiry: Order ${orderId} already left pending_verification — safe no-op.`,
          );
          ordersSkippedConflict++;
          continue;
        }
        if (err instanceof HeldQtyReleaseConflictError) {
          this.logger.error(
            `MANUAL RECONCILIATION REQUIRED: ${err.message} The Order's ->expired transition was rolled back; it remains pending_verification and will be retried on the next cron run.`,
          );
          ordersFlaggedForReconciliation++;
          continue;
        }
        throw err;
      }
    }

    if (ordersExpired > 0 || ordersFlaggedForReconciliation > 0) {
      this.logger.log(
        `StockHold expiry cron: ${ordersExpired} Order(s) expired, ${ordersSkippedConflict} skipped (already resolved), ${ordersFlaggedForReconciliation} flagged for manual reconciliation.`,
      );
    }

    return {
      ordersExpired,
      ordersSkippedConflict,
      ordersFlaggedForReconciliation,
    };
  }

  private async expireOneOrder(orderId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // --- AD-7/AD-16: pending_verification->expired, actorType=cron.
      // Runs FIRST (same ordering `PaypalPaymentsService` already
      // established for its own guarded transition + stock mutation): if
      // this guard affects 0 rows, the whole transaction rolls back
      // before any heldQty is ever touched.
      await guardedOrderStatusTransition(tx, {
        orderId,
        fromStatus: OrderStatus.PENDING_VERIFICATION,
        toStatus: OrderStatus.EXPIRED,
        actorType: OrderActorType.CRON,
      });

      // --- AD-6: release every still-active expired hold for this Order
      // in the SAME transaction as the transition above, so an `expired`
      // Order and a still-held Product can never coexist (this story's
      // core invariant, in both directions).
      const holds = await tx.stockHold.findMany({
        where: { orderId, releasedAt: null, expiresAt: { lte: now } },
      });

      for (const hold of holds) {
        const affected = await executeGuardedUpdate(
          tx,
          Prisma.sql`
            UPDATE "Products"
            SET "heldQty" = "heldQty" - ${hold.quantity}
            WHERE id = ${hold.productId}::uuid
              AND "heldQty" >= ${hold.quantity}
          `,
        );
        if (affected === 0) {
          throw new HeldQtyReleaseConflictError(
            orderId,
            hold.productId,
            hold.id,
          );
        }

        await tx.stockHold.update({
          where: { id: hold.id },
          data: { releasedAt: now },
        });
      }
    });
  }
}
