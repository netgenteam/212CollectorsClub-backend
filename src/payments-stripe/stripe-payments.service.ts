import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import { releaseOrderHolds } from '../common/order-stock-holds.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../common/order-status-transition.js';
import type { StripeWebhookEvent } from './stripe-client.interface.js';
import type { StripeWebhookOutcome } from './dto/stripe-webhook-ack.dto.js';

const PAID_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
const FAILED_TYPES = new Set([
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

/** Persisted `Stripe_Webhook_Events.outcome` values that need a manual refund. */
export const REFUND_PENDING_NO_STOCK = 'refund_pending_no_stock';
export const REFUND_PENDING_AFTER_TERMINAL = 'refund_pending_after_terminal';
export const REFUND_PENDING_OUTCOME_PREFIX = 'refund_pending_';

/**
 * Paid but the hold can no longer be consumed (AD-50 R1 residual): the paid
 * tx rolls back and a refund_pending_no_stock row is persisted separately.
 */
class StockDecrementConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(
      `Order ${orderId}: guarded stock decrement for Product ${productId} affected 0 rows.`,
    );
    this.name = 'StockDecrementConflictError';
  }
}

/**
 * Story 14.5 (AD-47). Idempotency: the event row is inserted first inside
 * the same transaction with ON CONFLICT DO NOTHING; a duplicate/concurrent
 * delivery waits on the unique index and then sees 0 rows inserted.
 */
@Injectable()
export class StripePaymentsService {
  private readonly logger = new Logger(StripePaymentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleEvent(event: StripeWebhookEvent): Promise<StripeWebhookOutcome> {
    const isPaid = PAID_TYPES.has(event.type);
    const isFailed = FAILED_TYPES.has(event.type);
    if (!isPaid && !isFailed) {
      return 'ignored';
    }
    // completed + unpaid: wait for async_payment_* (nothing recorded).
    if (
      event.type === 'checkout.session.completed' &&
      event.paymentStatus !== 'paid'
    ) {
      return 'noop';
    }

    try {
      return await this.prisma.$transaction((tx) =>
        this.process(tx, event, isPaid),
      );
    } catch (err) {
      if (err instanceof StockDecrementConflictError) {
        // AD-50: the paid tx rolled back (event row included). Persist the
        // refund-pending trace in a second short transaction; redelivery
        // then hits ON CONFLICT and is a duplicate no-op.
        const inserted = await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO "Stripe_Webhook_Events" ("eventId", "type", "orderId", "outcome")
          VALUES (${event.id}, ${event.type}, ${err.orderId}::uuid, ${REFUND_PENDING_NO_STOCK})
          ON CONFLICT ("eventId") DO NOTHING
        `);
        if (inserted === 0) {
          return 'duplicate';
        }
        this.logger.error(
          `PAID_BUT_NO_STOCK: ${err.message} Stripe event ${event.id} (session ${event.sessionId}) reports payment, but the hold could not be consumed; PAID transition rolled back, Order stays PAYMENT_PROCESSING. MANUAL REFUND REQUIRED from the Stripe dashboard.`,
        );
        return 'no_stock';
      }
      throw err;
    }
  }

  private async process(
    tx: Prisma.TransactionClient,
    event: StripeWebhookEvent,
    isPaid: boolean,
  ): Promise<StripeWebhookOutcome> {
    const inserted = await tx.$executeRaw(Prisma.sql`
      INSERT INTO "Stripe_Webhook_Events" ("eventId", "type", "outcome")
      VALUES (${event.id}, ${event.type}, 'pending')
      ON CONFLICT ("eventId") DO NOTHING
    `);
    if (inserted === 0) {
      this.logger.log(`Stripe event ${event.id} already processed - no-op.`);
      return 'duplicate';
    }

    const record = async (
      outcome: string,
      orderId: string | null,
    ): Promise<void> => {
      await tx.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: { outcome, orderId },
      });
    };

    const order = event.sessionId
      ? await tx.order.findUnique({
          where: { stripeCheckoutSessionId: event.sessionId },
          select: {
            id: true,
            status: true,
            totalUsd: true,
            lines: { select: { productId: true, quantity: true } },
          },
        })
      : null;

    if (!order) {
      this.logger.warn(
        `Stripe event ${event.id}: unknown session ${event.sessionId} - unknown_order.`,
      );
      await record('unknown_order', null);
      return 'unknown_order';
    }
    if (event.orderId && event.orderId !== order.id) {
      this.logger.error(
        `Stripe event ${event.id}: metadata orderId ${event.orderId} does not match Order ${order.id} for session ${event.sessionId} - treated as unknown_order.`,
      );
      await record('unknown_order', null);
      return 'unknown_order';
    }

    if (order.status !== OrderStatus.PAYMENT_PROCESSING) {
      return this.recordNotProcessing(
        event,
        order.id,
        order.status,
        isPaid,
        record,
      );
    }

    if (isPaid) {
      const expectedCents = order.totalUsd
        .mul(100)
        .toDecimalPlaces(0)
        .toNumber();
      if (
        event.amountTotalCents !== expectedCents ||
        event.currency?.toLowerCase() !== 'usd'
      ) {
        this.logger.error(
          `AMOUNT_MISMATCH: Stripe event ${event.id} for Order ${order.id}: got ${event.amountTotalCents} ${event.currency}, expected ${expectedCents} usd. Order not marked PAID.`,
        );
        await record('amount_mismatch', order.id);
        return 'amount_mismatch';
      }
    }

    try {
      await guardedOrderStatusTransition(tx, {
        orderId: order.id,
        fromStatus: OrderStatus.PAYMENT_PROCESSING,
        toStatus: isPaid ? OrderStatus.PAID : OrderStatus.PAYMENT_FAILED,
        actorType: OrderActorType.STRIPE_WEBHOOK,
      });
    } catch (err) {
      if (err instanceof OrderTransitionConflictError) {
        // Another actor (event / timeout cron) won the race; the failed
        // UPDATE is not a SQL error, so the tx (and our event row) stays
        // usable. Re-read the committed status: a confirmed payment must
        // never vanish silently if the loser lost to a terminal failure.
        const current = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        return this.recordNotProcessing(
          event,
          order.id,
          current?.status ?? OrderStatus.PAYMENT_FAILED,
          isPaid,
          record,
        );
      }
      throw err;
    }

    if (isPaid) {
      await this.consumeHolds(tx, order.id, order.lines);
      if (event.paymentIntentId) {
        await tx.order.update({
          where: { id: order.id },
          data: { stripePaymentIntentId: event.paymentIntentId },
        });
      }
      await record('paid', order.id);
      this.logger.log(`Order ${order.id} PAID via Stripe event ${event.id}.`);
      return 'paid';
    }

    // AD-50: the transition winner releases the holds (heldQty only).
    await releaseOrderHolds(tx, order.id);
    await record('failed', order.id);
    this.logger.log(
      `Order ${order.id} PAYMENT_FAILED via Stripe event ${event.id} (${event.type}).`,
    );
    return 'failed';
  }

  /**
   * Event for an Order no longer PAYMENT_PROCESSING. A `paid` event on a
   * PAYMENT_FAILED Order (expired / async failure / cron timeout) means
   * Stripe charged the buyer: persist refund_pending_after_terminal + ERROR.
   */
  private async recordNotProcessing(
    event: StripeWebhookEvent,
    orderId: string,
    status: OrderStatus,
    isPaid: boolean,
    record: (outcome: string, orderId: string | null) => Promise<void>,
  ): Promise<StripeWebhookOutcome> {
    if (isPaid && status === OrderStatus.PAYMENT_FAILED) {
      this.logger.error(
        `PAID_AFTER_TERMINAL: Stripe event ${event.id} reports payment for Order ${orderId} already PAYMENT_FAILED. MANUAL REFUND REQUIRED from the Stripe dashboard.`,
      );
      await record(REFUND_PENDING_AFTER_TERMINAL, orderId);
      return 'noop';
    }
    await record('noop', orderId);
    return 'noop';
  }

  /**
   * AD-50: consumes the Order's active holds exactly like the Pago Móvil
   * confirm (9.2): stock and heldQty drop together, guarded by
   * `stock >= q AND heldQty >= q`. Every OrderLine must be covered exactly
   * by active holds; anything else (hold released/reduced manually) is the
   * R1 residual.
   */
  private async consumeHolds(
    tx: Prisma.TransactionClient,
    orderId: string,
    lines: { productId: string; quantity: number }[],
  ): Promise<void> {
    const holds = await tx.stockHold.findMany({
      where: { orderId, releasedAt: null },
    });
    for (const line of lines) {
      const held = holds
        .filter((hold) => hold.productId === line.productId)
        .reduce((sum, hold) => sum + hold.quantity, 0);
      if (held !== line.quantity) {
        throw new StockDecrementConflictError(orderId, line.productId);
      }
    }
    for (const hold of holds) {
      const affected = await executeGuardedUpdate(
        tx,
        Prisma.sql`
          UPDATE "Products"
          SET stock = stock - ${hold.quantity},
              "heldQty" = "heldQty" - ${hold.quantity}
          WHERE id = ${hold.productId}::uuid
            AND stock >= ${hold.quantity}
            AND "heldQty" >= ${hold.quantity}
        `,
      );
      if (affected === 0) {
        throw new StockDecrementConflictError(orderId, hold.productId);
      }
      const released = await tx.stockHold.updateMany({
        where: { id: hold.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      if (released.count === 0) {
        throw new StockDecrementConflictError(orderId, hold.productId);
      }
    }
  }
}
