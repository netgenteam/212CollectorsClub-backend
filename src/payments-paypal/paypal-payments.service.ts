import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../common/order-status-transition.js';
import { PAYPAL_CLIENT } from './paypal-client.interface.js';
import type {
  PaypalCaptureStatus,
  PaypalClient,
} from './paypal-client.interface.js';

function paypalOrderNotFoundException(paypalOrderId: string): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'PAYPAL_ORDER_NOT_FOUND',
    `No Order in this system is associated with PayPal order "${paypalOrderId}".`,
  );
}

function verificationMismatchException(paypalOrderId: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'PAYPAL_VERIFICATION_MISMATCH',
    `PayPal's own verification response for order "${paypalOrderId}" referenced a different internal Order than the one this system has mapped to it — refusing to act on it.`,
  );
}

/**
 * Story 4.3 (AD-13): thrown internally when the guarded stock-decrement
 * UPDATE (`WHERE stock >= qty`, no `heldQty` term — PayPal orders never
 * hold stock) affects 0 rows. Unlike Story 4.1's checkout-time stock guard
 * (which can reject the checkout outright, before anything is committed),
 * this happens AFTER the buyer has already paid PayPal — there is no
 * "reject the request" outcome available anymore. See
 * `applyPaidTransition`'s catch block for how this is handled: logged as a
 * loud, explicit flag for manual admin reconciliation (out of this story's
 * scope — Epic 9), never silently swallowed, but also never allowed to
 * surface as a 5xx that would make PayPal retry a webhook retrying will
 * never fix.
 */
class StockDecrementConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(
      `Order ${orderId}: guarded stock decrement for Product ${productId} affected 0 rows (insufficient stock at PayPal confirmation time).`,
    );
    this.name = 'StockDecrementConflictError';
  }
}

export type PaypalWebhookOutcome = 'paid' | 'payment_failed' | 'noop';

type OrderWithLines = {
  id: string;
  lines: { productId: string; quantity: number }[];
};

/**
 * Story 4.3, AC2-AC4. Handles the "PayPal has confirmed (or denied) this
 * payment" side of the flow — the counterpart to `CheckoutService`'s
 * PayPal branch, which only ever creates the Order in `payment_processing`
 * and asks PayPal to create its own order/session.
 *
 * **Endpoint design choice (webhook vs. a buyer-facing server-side
 * verification call)**: this is modeled as a PayPal *webhook* receiver
 * (`PaypalWebhookController`, `POST /payments/paypal/webhook`), not a
 * buyer-facing "confirm my payment" endpoint the frontend calls after
 * redirect. Reasoning: a webhook is PayPal's own server telling THIS
 * server what happened, over a channel the buyer's browser never touches
 * — so there is no client-supplied "paid" flag to even be tempted to trust
 * in the first place, which directly serves this story's core requirement.
 * A frontend-driven "I'm back from PayPal, please confirm" call would
 * still need to independently re-verify with PayPal anyway (never trust
 * the redirect itself), so it would end up doing exactly the same
 * `captureAndVerifyOrder` call this service already makes — the webhook
 * shape is simply the more standard, more secure place to put it. (A real
 * deployment would likely want BOTH: this webhook as the source of truth,
 * plus an idempotent buyer-facing status-check endpoint so the frontend
 * can poll/display progress — the latter is a straightforward read-only
 * addition on top of this, left out here as out of this story's scope.)
 *
 * **Never trusts the incoming event's own claimed outcome**: whatever
 * `eventType` (or any other field) the webhook body carries is logged for
 * observability only. The paid-vs-failed decision is made EXCLUSIVELY from
 * a fresh call to the injected `PaypalClient.captureAndVerifyOrder` — see
 * that interface's own doc comment.
 *
 * **Reuses, never reinvents, Story 4.1's guarded-transition helper**:
 * every status change here goes through
 * `guardedOrderStatusTransition` (`src/common/order-status-transition.ts`)
 * exactly as Story 4.1 built it — this is that helper's first real UPDATE-
 * on-an-existing-row consumer (4.1 itself only ever used
 * `recordInitialOrderStatus`, a fresh INSERT). `OrderTransitionConflictError`
 * (0 rows affected — the Order already left `payment_processing`, whether
 * because it's already `paid`, already `payment_failed`, or is racing
 * another PayPal event for the same Order right now) is exactly this
 * story's idempotency requirement (AC4): caught here and turned into a
 * safe `'noop'`, never a thrown error, never a decremented stock, never a
 * non-2xx response to PayPal.
 */
@Injectable()
export class PaypalPaymentsService {
  private readonly logger = new Logger(PaypalPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYPAL_CLIENT) private readonly paypalClient: PaypalClient,
  ) {}

  async confirmPayment(
    paypalOrderId: string,
    eventType?: string,
  ): Promise<PaypalWebhookOutcome> {
    const order = await this.prisma.order.findFirst({
      where: { paypalOrderId },
      select: {
        id: true,
        lines: { select: { productId: true, quantity: true } },
      },
    });
    if (!order) {
      throw paypalOrderNotFoundException(paypalOrderId);
    }

    this.logger.log(
      `PayPal webhook received for Order ${order.id} (paypalOrderId=${paypalOrderId}, eventType=${eventType ?? 'unknown'}) — verifying independently against PayPal before acting.`,
    );

    // --- The ONLY source of truth for paid vs. failed. `eventType` above
    // played no part in this call or in the branch below.
    const verification =
      await this.paypalClient.captureAndVerifyOrder(paypalOrderId);

    if (
      verification.internalOrderId &&
      verification.internalOrderId !== order.id
    ) {
      this.logger.error(
        `PayPal verification internalOrderId mismatch for paypalOrderId=${paypalOrderId}: local Order=${order.id}, PayPal echoed=${verification.internalOrderId}.`,
      );
      throw verificationMismatchException(paypalOrderId);
    }

    if (verification.status === 'COMPLETED') {
      return this.applyPaidTransition(order);
    }
    return this.applyFailedTransition(order.id, verification.status);
  }

  private async applyPaidTransition(
    order: OrderWithLines,
  ): Promise<PaypalWebhookOutcome> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // --- AD-16: guarded payment_processing->paid, actorType=paypal_webhook.
        await guardedOrderStatusTransition(tx, {
          orderId: order.id,
          fromStatus: OrderStatus.PAYMENT_PROCESSING,
          toStatus: OrderStatus.PAID,
          actorType: OrderActorType.PAYPAL_WEBHOOK,
        });

        // --- AD-13: guarded atomic stock decrement per line, NO heldQty
        // term (PayPal orders never hold stock, unlike Story 4.1's Pago
        // Móvil AD-6 hold-then-convert flow — this is a direct decrement).
        for (const line of order.lines) {
          const affected = await executeGuardedUpdate(
            tx,
            Prisma.sql`
              UPDATE "Products"
              SET stock = stock - ${line.quantity}
              WHERE id = ${line.productId}::uuid
                AND stock >= ${line.quantity}
            `,
          );
          if (affected === 0) {
            throw new StockDecrementConflictError(order.id, line.productId);
          }
        }
      });

      this.logger.log(
        `Order ${order.id} confirmed PAID via PayPal webhook; stock decremented for ${order.lines.length} line(s).`,
      );
      return 'paid';
    } catch (err) {
      if (err instanceof OrderTransitionConflictError) {
        // AC4: the guard's WHERE status='payment_processing' matched 0
        // rows — this Order already left that state (already paid,
        // already failed, or a concurrent duplicate winning the race).
        // Safe no-op: no stock touched, no error thrown to the caller.
        this.logger.log(
          `Order ${order.id}: duplicate/late PayPal confirmation ignored (already left payment_processing) — safe no-op, no double stock decrement.`,
        );
        return 'noop';
      }
      if (err instanceof StockDecrementConflictError) {
        // See this class's own doc comment above `StockDecrementConflictError`
        // for why this is intentionally NOT re-thrown as a 5xx: PayPal
        // already has the buyer's money at this point, and retrying the
        // webhook will never make stock reappear. Acknowledged (200/noop)
        // to stop PayPal's retry loop; the actual business problem is
        // flagged loudly here for a human (Epic 9 admin tooling) to
        // reconcile — not solved by this story.
        this.logger.error(
          `MANUAL RECONCILIATION REQUIRED: ${err.message} PayPal payment for Order ${order.id} was verified COMPLETED, but stock for Product ${err.productId} ran out before confirmation — the PAID transition was rolled back and the Order remains in payment_processing. The buyer's PayPal payment may already be captured.`,
        );
        return 'noop';
      }
      throw err;
    }
  }

  private async applyFailedTransition(
    orderId: string,
    reportedStatus: PaypalCaptureStatus,
  ): Promise<PaypalWebhookOutcome> {
    try {
      await this.prisma.$transaction((tx) =>
        guardedOrderStatusTransition(tx, {
          orderId,
          fromStatus: OrderStatus.PAYMENT_PROCESSING,
          toStatus: OrderStatus.PAYMENT_FAILED,
          actorType: OrderActorType.PAYPAL_WEBHOOK,
        }),
      );
      this.logger.log(
        `Order ${orderId} transitioned to payment_failed (PayPal-reported status: ${reportedStatus}). Stock was never touched.`,
      );
      return 'payment_failed';
    } catch (err) {
      if (err instanceof OrderTransitionConflictError) {
        this.logger.log(
          `Order ${orderId}: duplicate/late PayPal failure notification ignored (already left payment_processing) — safe no-op.`,
        );
        return 'noop';
      }
      throw err;
    }
  }
}
