import {
  OrderTransitionConflictError,
  guardedOrderStatusTransition,
  recordInitialOrderStatus,
} from './order-status-transition.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';

/**
 * Story 4.1: this helper is introduced by Story 4.1 (AD-16) but not
 * exercised by CheckoutService's own `[]->pending_verification` path
 * beyond `recordInitialOrderStatus` — `guardedOrderStatusTransition` is
 * forward-looking infrastructure for the first REAL Order UPDATE
 * transition, which lands in Story 4.3 (PayPal payment_processing->paid/
 * payment_failed). These tests exist so that infrastructure is proven
 * correct here, not left untested until 4.3 happens to exercise it.
 */
describe('order-status-transition', () => {
  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    tx = {
      $executeRaw: vi.fn(),
      orderStatusHistory: { create: vi.fn() },
    };
  });

  describe('recordInitialOrderStatus', () => {
    it('writes an OrderStatusHistory row with fromStatus=null (no guarded UPDATE involved — this is a fresh INSERT)', async () => {
      await recordInitialOrderStatus(tx as never, {
        orderId: 'order-1',
        toStatus: OrderStatus.PENDING_VERIFICATION,
        actorType: OrderActorType.SYSTEM,
      });

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: null,
          toStatus: OrderStatus.PENDING_VERIFICATION,
          actorType: OrderActorType.SYSTEM,
          adminUserId: null,
        },
      });
    });

    it('carries adminUserId through when provided', async () => {
      await recordInitialOrderStatus(tx as never, {
        orderId: 'order-1',
        toStatus: OrderStatus.PAYMENT_PROCESSING,
        actorType: OrderActorType.SYSTEM,
        adminUserId: 'admin-1',
      });

      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ adminUserId: 'admin-1' }) as unknown,
      });
    });
  });

  describe('guardedOrderStatusTransition', () => {
    it('runs the guarded UPDATE and writes the history row when exactly one row is affected', async () => {
      tx.$executeRaw.mockResolvedValue(1);

      await guardedOrderStatusTransition(tx as never, {
        orderId: 'order-1',
        fromStatus: OrderStatus.PENDING_VERIFICATION,
        toStatus: OrderStatus.PAID,
        actorType: OrderActorType.ADMIN,
        adminUserId: 'admin-1',
      });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.PAID,
          actorType: OrderActorType.ADMIN,
          adminUserId: 'admin-1',
        },
      });
    });

    it('throws OrderTransitionConflictError and never writes a history row when the guarded UPDATE affects 0 rows (the Order was no longer in fromStatus)', async () => {
      tx.$executeRaw.mockResolvedValue(0);

      await expect(
        guardedOrderStatusTransition(tx as never, {
          orderId: 'order-1',
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.PAID,
          actorType: OrderActorType.ADMIN,
        }),
      ).rejects.toBeInstanceOf(OrderTransitionConflictError);
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('the thrown error carries the orderId and the stale expected fromStatus, for the caller to translate into its own response shape', async () => {
      tx.$executeRaw.mockResolvedValue(0);

      await expect(
        guardedOrderStatusTransition(tx as never, {
          orderId: 'order-42',
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.EXPIRED,
          actorType: OrderActorType.CRON,
        }),
      ).rejects.toMatchObject({
        orderId: 'order-42',
        expectedFromStatus: OrderStatus.PENDING_VERIFICATION,
      });
    });

    it('defaults adminUserId to null when omitted (a non-ADMIN actor)', async () => {
      tx.$executeRaw.mockResolvedValue(1);

      await guardedOrderStatusTransition(tx as never, {
        orderId: 'order-1',
        fromStatus: OrderStatus.PENDING_VERIFICATION,
        toStatus: OrderStatus.EXPIRED,
        actorType: OrderActorType.CRON,
      });

      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ adminUserId: null }) as unknown,
      });
    });
  });
});
