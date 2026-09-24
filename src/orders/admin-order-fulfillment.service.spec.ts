import { AdminOrderFulfillmentService } from './admin-order-fulfillment.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';

const ADMIN: AuthenticatedAdminUser = {
  id: 'admin-1',
  username: 'e2e-admin',
  email: 'admin@212collectorsclub.test',
  roleTier: null,
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

/**
 * Story 9.3: unit-level coverage of `AdminOrderFulfillmentService`'s own
 * branching logic (which errors translate to which errorCode/status), with
 * `PrismaService` mocked the exact same way `AdminOrderPaymentService`'s own
 * spec mocks it (Story 9.2) — `$transaction` invokes the real callback
 * against a mocked `tx`, and `guardedOrderStatusTransition`/
 * `executeGuardedUpdate` themselves are NOT mocked (already unit-tested in
 * `order-status-transition.spec.ts`), only driven via `tx.$executeRaw`'s
 * scripted return values. Full real-Postgres coverage (the actual guarded
 * transition, the actual stock re-increment, real concurrency) lives in
 * `test/admin-fulfillment-decision.e2e-spec.ts`.
 */
describe('AdminOrderFulfillmentService', () => {
  let service: AdminOrderFulfillmentService;
  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    orderLine: { findMany: ReturnType<typeof vi.fn> };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    order: {
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    tx = {
      $executeRaw: vi.fn(),
      orderStatusHistory: { create: vi.fn() },
      orderLine: { findMany: vi.fn() },
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    };

    service = new AdminOrderFulfillmentService(
      prisma as unknown as PrismaService,
    );
  });

  describe('fulfillOrder', () => {
    it('404 ORDER_NOT_FOUND when no such Order exists — never opens a transaction', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.fulfillOrder('order-missing', ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'ORDER_NOT_FOUND' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: guarded paid->fulfilled transition succeeds, no OrderLine/stock lookup ever happens', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw.mockResolvedValueOnce(1); // guardedOrderStatusTransition UPDATE
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        status: 'FULFILLED',
        updatedAt: new Date('2026-09-24T18:03:11.000Z'),
      });

      const result = await service.fulfillOrder('order-1', ADMIN);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: 'PAID',
          toStatus: 'FULFILLED',
          actorType: 'ADMIN',
          adminUserId: ADMIN.id,
        }) as unknown,
      });
      expect(tx.orderLine.findMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        orderId: 'order-1',
        status: 'fulfilled',
        updatedAt: '2026-09-24T18:03:11.000Z',
      });
    });

    it('409 ORDER_NOT_PAID (with the current status) when the guarded transition affects 0 rows — a duplicate/illegal fulfill is an explicit conflict, never a silent 200', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1' }) // assertOrderExists
        .mockResolvedValueOnce({ status: 'PENDING_VERIFICATION' }); // translateTransitionError's re-read
      tx.$executeRaw.mockResolvedValueOnce(0); // transition guard: 0 rows

      await expect(
        service.fulfillOrder('order-1', ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'ORDER_NOT_PAID',
          details: { currentStatus: 'pending_verification' },
        },
      });
    });
  });

  describe('cancelOrder', () => {
    it('404 ORDER_NOT_FOUND when no such Order exists — never opens a transaction', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.cancelOrder('order-missing', ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'ORDER_NOT_FOUND' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: guarded transition succeeds, stock is re-incremented for every OrderLine via the exact compensating guard', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw
        .mockResolvedValueOnce(1) // guardedOrderStatusTransition UPDATE "Orders"
        .mockResolvedValueOnce(1) // line 1 stock re-increment
        .mockResolvedValueOnce(1); // line 2 stock re-increment
      tx.orderLine.findMany.mockResolvedValue([
        { productId: 'product-1', quantity: 2 },
        { productId: 'product-2', quantity: 5 },
      ]);
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        status: 'CANCELLED',
        updatedAt: new Date('2026-09-24T18:10:00.000Z'),
      });

      const result = await service.cancelOrder('order-1', ADMIN);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: 'PAID',
          toStatus: 'CANCELLED',
          actorType: 'ADMIN',
          adminUserId: ADMIN.id,
        }) as unknown,
      });
      expect(result).toEqual({
        orderId: 'order-1',
        status: 'cancelled',
        updatedAt: '2026-09-24T18:10:00.000Z',
      });
    });

    it('409 ORDER_NOT_PAID when the guarded transition affects 0 rows — never re-reads OrderLines, never touches stock', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1' })
        .mockResolvedValueOnce({ status: 'FULFILLED' });
      tx.$executeRaw.mockResolvedValueOnce(0);

      await expect(service.cancelOrder('order-1', ADMIN)).rejects.toMatchObject(
        {
          status: 409,
          response: {
            errorCode: 'ORDER_NOT_PAID',
            details: { currentStatus: 'fulfilled' },
          },
        },
      );
      expect(tx.orderLine.findMany).not.toHaveBeenCalled();
    });

    it("409 STOCK_REINCREMENT_CONFLICT, whole transaction rolled back, when a line's compensating UPDATE affects 0 rows", async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw
        .mockResolvedValueOnce(1) // transition succeeds
        .mockResolvedValueOnce(1) // line 1 succeeds
        .mockResolvedValueOnce(0); // line 2 fails
      tx.orderLine.findMany.mockResolvedValue([
        { productId: 'product-1', quantity: 2 },
        { productId: 'product-2', quantity: 5 },
      ]);

      await expect(service.cancelOrder('order-1', ADMIN)).rejects.toMatchObject(
        {
          status: 409,
          response: {
            errorCode: 'STOCK_REINCREMENT_CONFLICT',
            details: { productId: 'product-2' },
          },
        },
      );
    });
  });
});
