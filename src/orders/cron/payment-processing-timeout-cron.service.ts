import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OrderActorType,
  OrderStatus,
  PaymentRail,
} from '../../generated/prisma/enums.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../../common/order-status-transition.js';
import {
  HeldQtyReleaseError,
  releaseOrderHolds,
} from '../../common/order-stock-holds.js';

/**
 * AD-7: an Order enters `payment_processing` exactly once, at creation
 * (Story 4.3's PayPal branch — `CheckoutService.checkout` writes this as
 * the Order's INITIAL status via `recordInitialOrderStatus`, never as a
 * later transition into it from anywhere else), and the only two legal
 * transitions OUT of it (`->paid`, `->payment_failed`, both applied by
 * `PaypalPaymentsService`) never lead back into it. So `Order.createdAt`
 * IS "when this Order entered payment_processing" — no separate
 * "enteredProcessingAt" column is needed to measure this timeout.
 */
const PAYMENT_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Story 14.4 (AD-46): Stripe sessions expire at 30 min, so the safety-net cron
 * waits 60 min for `paymentRail=STRIPE` to avoid racing `checkout.session.
 * expired`/late-payment webhooks. Collapses to the single cutoff once PayPal
 * is removed (14.6).
 */
const STRIPE_PAYMENT_PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;

export interface PaymentProcessingTimeoutCheckResult {
  /** Orders successfully transitioned payment_processing -> payment_failed. */
  ordersFailed: number;
  /** Orders whose candidate row was already stale by the time this ran —
   * the guarded transition's WHERE matched 0 rows because the Order
   * already left payment_processing (a PayPal webhook resolved it, or a
   * previous/overlapping cron run already won this same Order). Safe
   * no-op. */
  ordersSkippedConflict: number;
}

/**
 * Story 5.2 (AD-7, AD-16): fails any Order that has sat in
 * `payment_processing` (PayPal checkout submitted, but neither a "paid"
 * nor a "declined" webhook ever arrived) for more than 30 minutes — so a
 * buyer's abandoned/interrupted PayPal flow doesn't leave an Order stuck
 * ambiguously forever.
 *
 * **Never decrements `stock`**: a PayPal Order never holds stock (AD-13).
 * Story 14.5b (AD-50): a Stripe Order does hold stock; the cron that WINS
 * the guarded transition releases its active holds (heldQty only) in the
 * same transaction. A PayPal Order simply has no holds to release.
 *
 * **Testable without the real interval**: same shape as
 * `StockHoldExpiryCronService` — `handleCron` (the `@Cron`-decorated
 * method) does nothing but call the public `runTimeoutCheck`, which does
 * all the real work and returns a summary. Tests call `runTimeoutCheck()`
 * directly.
 *
 * **Reuses, never reimplements, Story 4.1's guarded-transition helper**:
 * same `guardedOrderStatusTransition` `PaypalPaymentsService` and
 * `StockHoldExpiryCronService` already use — this is its 4th real
 * caller in this codebase.
 */
@Injectable()
export class PaymentProcessingTimeoutCronService {
  private readonly logger = new Logger(
    PaymentProcessingTimeoutCronService.name,
  );

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'payment-processing-timeout' })
  async handleCron(): Promise<void> {
    await this.runTimeoutCheck();
  }

  async runTimeoutCheck(): Promise<PaymentProcessingTimeoutCheckResult> {
    const now = Date.now();
    const cutoff = new Date(now - PAYMENT_PROCESSING_TIMEOUT_MS);
    const stripeCutoff = new Date(now - STRIPE_PAYMENT_PROCESSING_TIMEOUT_MS);

    // --- Candidate selection only — same reasoning as
    // StockHoldExpiryCronService's own candidate query: the guarded
    // transition below is the actual correctness guarantee.
    const staleOrders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAYMENT_PROCESSING,
        OR: [
          {
            paymentRail: { not: PaymentRail.STRIPE },
            createdAt: { lte: cutoff },
          },
          { paymentRail: PaymentRail.STRIPE, createdAt: { lte: stripeCutoff } },
        ],
      },
      select: { id: true },
    });

    let ordersFailed = 0;
    let ordersSkippedConflict = 0;

    for (const { id: orderId } of staleOrders) {
      try {
        // --- AD-7/AD-16: payment_processing->payment_failed,
        // actorType=cron. NEVER decrements stock — see this class's own
        // doc comment.
        await this.prisma.$transaction(async (tx) => {
          await guardedOrderStatusTransition(tx, {
            orderId,
            fromStatus: OrderStatus.PAYMENT_PROCESSING,
            toStatus: OrderStatus.PAYMENT_FAILED,
            actorType: OrderActorType.CRON,
          });
          // AD-50: only the transition winner releases the holds.
          await releaseOrderHolds(tx, orderId);
        });
        ordersFailed++;
      } catch (err) {
        if (err instanceof OrderTransitionConflictError) {
          // A PayPal webhook (or a previous/overlapping cron run) already
          // resolved this Order between the candidate query above and
          // this transaction — safe skip, no history duplicated.
          this.logger.log(
            `Payment-processing timeout: Order ${orderId} already left payment_processing — safe no-op.`,
          );
          ordersSkippedConflict++;
          continue;
        }
        if (err instanceof HeldQtyReleaseError) {
          this.logger.error(
            `MANUAL RECONCILIATION REQUIRED: ${err.message} The ->payment_failed transition was rolled back; retried on the next run.`,
          );
          continue;
        }
        throw err;
      }
    }

    if (ordersFailed > 0) {
      this.logger.log(
        `Payment-processing timeout cron: ${ordersFailed} Order(s) transitioned to payment_failed, ${ordersSkippedConflict} skipped (already resolved).`,
      );
    }

    return { ordersFailed, ordersSkippedConflict };
  }
}
