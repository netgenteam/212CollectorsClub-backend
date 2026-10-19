import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
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

/** Paid but stock ran out: tx rolls back (R1, manual refund from Stripe). */
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
 * Story 14.5 (AD-47). Pattern copied from PaypalPaymentsService (retired in
 * 14.6; nothing shared). Idempotency: the event row is inserted first inside
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
        this.logger.error(
          `PAID_BUT_NO_STOCK: ${err.message} Stripe event ${event.id} (session ${event.sessionId}) reports payment, but stock ran out; PAID transition rolled back, Order stays PAYMENT_PROCESSING. MANUAL REFUND REQUIRED from the Stripe dashboard.`,
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
      if (isPaid && order.status === OrderStatus.PAYMENT_FAILED) {
        this.logger.error(
          `PAID_AFTER_TERMINAL: Stripe event ${event.id} reports payment for Order ${order.id} already PAYMENT_FAILED. MANUAL REFUND REQUIRED from the Stripe dashboard.`,
        );
      }
      await record('noop', order.id);
      return 'noop';
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
        // Another event for the same order won the race; the failed UPDATE
        // is not a SQL error, so the tx (and our event row) stays usable.
        await record('noop', order.id);
        return 'noop';
      }
      throw err;
    }

    if (isPaid) {
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

    await record('failed', order.id);
    this.logger.log(
      `Order ${order.id} PAYMENT_FAILED via Stripe event ${event.id} (${event.type}).`,
    );
    return 'failed';
  }
}
