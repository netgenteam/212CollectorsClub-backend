import { AdminOrderPaymentService } from './admin-order-payment.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UPLOADS_PRIVATE_ROOT } from './upload-paths.constants.js';
import { join } from 'node:path';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';

const accessMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) =>
    (accessMock as (...a: unknown[]) => unknown)(...args),
}));

const ADMIN: AuthenticatedAdminUser = {
  id: 'admin-1',
  username: 'e2e-admin',
  email: 'admin@212collectorsclub.test',
  roleTier: null,
  createdAt: new Date('2026-09-24T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T00:00:00.000Z'),
};

/**
 * Story 9.2: unit-level coverage of `AdminOrderPaymentService`'s own
 * branching logic (which errors translate to which errorCode/status), with
 * `PrismaService` mocked the exact same way `StockHoldExpiryCronService`'s
 * own spec mocks it (Story 5.2) — `$transaction` invokes the real callback
 * against a mocked `tx`, and `guardedOrderStatusTransition`/
 * `executeGuardedUpdate` themselves are NOT mocked (already unit-tested in
 * `order-status-transition.spec.ts`), only driven via `tx.$executeRaw`'s
 * scripted return values. Full real-Postgres coverage (the actual
 * stock/heldQty decrement, the actual guarded transition, real concurrency,
 * a real file served end-to-end) lives in
 * `test/admin-payment-decision.e2e-spec.ts`.
 */
describe('AdminOrderPaymentService', () => {
  let service: AdminOrderPaymentService;
  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    stockHold: {
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    order: {
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
    };
    proofOfPayment: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    accessMock.mockReset().mockResolvedValue(undefined);

    tx = {
      $executeRaw: vi.fn(),
      orderStatusHistory: { create: vi.fn() },
      stockHold: { findMany: vi.fn(), update: vi.fn() },
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      proofOfPayment: { findFirst: vi.fn() },
    };

    service = new AdminOrderPaymentService(prisma as unknown as PrismaService);
  });

  describe('getProofOfPaymentFile', () => {
    it('404 ORDER_NOT_FOUND when no such Order exists', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.getProofOfPaymentFile('order-missing'),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'ORDER_NOT_FOUND' },
      });
      expect(prisma.proofOfPayment.findFirst).not.toHaveBeenCalled();
    });

    it('404 PROOF_OF_PAYMENT_NOT_FOUND when the Order exists but nothing was uploaded', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'order-1' });
      prisma.proofOfPayment.findFirst.mockResolvedValue(null);

      await expect(
        service.getProofOfPaymentFile('order-1'),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'PROOF_OF_PAYMENT_NOT_FOUND' },
      });
    });

    it('resolves the absolute path, mimeType, and a downloadFileName built ONLY from the server-generated filePath basename', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'order-1' });
      prisma.proofOfPayment.findFirst.mockResolvedValue({
        id: 'pop-1',
        filePath: 'proof-of-payment/3f9e2b1a-abcd.png',
        mimeType: 'image/png',
        sizeBytes: 482113,
      });

      const result = await service.getProofOfPaymentFile('order-1');

      expect(result).toEqual({
        absolutePath: join(
          UPLOADS_PRIVATE_ROOT,
          'proof-of-payment/3f9e2b1a-abcd.png',
        ),
        mimeType: 'image/png',
        downloadFileName: '3f9e2b1a-abcd.png',
        sizeBytes: 482113,
      });
      expect(prisma.proofOfPayment.findFirst).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('404 PROOF_OF_PAYMENT_FILE_MISSING when the DB row exists but the file is unreadable on disk', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'order-1' });
      prisma.proofOfPayment.findFirst.mockResolvedValue({
        id: 'pop-1',
        filePath: 'proof-of-payment/gone.png',
        mimeType: 'image/png',
      });
      accessMock.mockRejectedValue(new Error('ENOENT'));

      await expect(
        service.getProofOfPaymentFile('order-1'),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'PROOF_OF_PAYMENT_FILE_MISSING' },
      });
    });
  });

  describe('confirmPayment', () => {
    it('404 ORDER_NOT_FOUND when no such Order exists — never opens a transaction', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmPayment('order-missing', ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'ORDER_NOT_FOUND' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: guarded transition succeeds, every active StockHold is decremented via the exact AD-13 guard and released, response reflects the committed row', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' }); // assertOrderExists
      tx.$executeRaw
        .mockResolvedValueOnce(1) // guardedOrderStatusTransition UPDATE "Orders"
        .mockResolvedValueOnce(1) // hold 1 stock+heldQty guard
        .mockResolvedValueOnce(1); // hold 2 stock+heldQty guard
      tx.stockHold.findMany.mockResolvedValue([
        { id: 'hold-1', productId: 'product-1', quantity: 2 },
        { id: 'hold-2', productId: 'product-2', quantity: 1 },
      ]);
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        status: 'PAID',
        updatedAt: new Date('2026-09-24T18:03:11.000Z'),
      });

      const result = await service.confirmPayment('order-1', ADMIN);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: 'PENDING_VERIFICATION',
          toStatus: 'PAID',
          actorType: 'ADMIN',
          adminUserId: ADMIN.id,
        }) as unknown,
      });
      expect(tx.stockHold.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'hold-1' },
        data: { releasedAt: expect.any(Date) as unknown },
      });
      expect(tx.stockHold.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'hold-2' },
        data: { releasedAt: expect.any(Date) as unknown },
      });
      expect(result).toEqual({
        orderId: 'order-1',
        status: 'paid',
        updatedAt: '2026-09-24T18:03:11.000Z',
      });
    });

    it('409 ORDER_NOT_PENDING_VERIFICATION (with the current status) when the guarded transition affects 0 rows — a duplicate/double-click confirm is an explicit conflict, never a silent 200', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1' }) // assertOrderExists
        .mockResolvedValueOnce({ status: 'PAID' }); // translateDecisionError's re-read
      tx.$executeRaw.mockResolvedValueOnce(0); // transition guard: 0 rows

      await expect(
        service.confirmPayment('order-1', ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'ORDER_NOT_PENDING_VERIFICATION',
          details: { currentStatus: 'paid' },
        },
      });
      expect(tx.stockHold.findMany).not.toHaveBeenCalled();
      expect(tx.stockHold.update).not.toHaveBeenCalled();
    });

    it('409 INSUFFICIENT_STOCK, Order left untouched (rolled back), when the AD-13 guard affects 0 rows for a line — never a partial decrement', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw
        .mockResolvedValueOnce(1) // transition succeeds
        .mockResolvedValueOnce(1) // hold 1 succeeds
        .mockResolvedValueOnce(0); // hold 2 fails: insufficient stock
      tx.stockHold.findMany.mockResolvedValue([
        { id: 'hold-1', productId: 'product-1', quantity: 2 },
        { id: 'hold-2', productId: 'product-2', quantity: 99 },
      ]);

      await expect(
        service.confirmPayment('order-1', ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'INSUFFICIENT_STOCK',
          details: { productId: 'product-2' },
        },
      });
      // hold-1's release was attempted inside the (mocked) transaction, but
      // hold-2's guard failure is what the whole real Prisma transaction
      // rolls back on — nothing about this test's mock disproves atomicity
      // (that's covered for real against Postgres in the e2e suite), only
      // that the second line's 0-rows guard is what triggers the abort and
      // hold-2 itself is never marked released.
      expect(tx.stockHold.update).not.toHaveBeenCalledWith({
        where: { id: 'hold-2' },
        data: expect.anything() as unknown,
      });
    });
  });

  describe('rejectPayment', () => {
    it('404 ORDER_NOT_FOUND when no such Order exists', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.rejectPayment('order-missing', ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'ORDER_NOT_FOUND' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: guarded transition to payment_rejected succeeds, heldQty-only release (never stock) for every active hold', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw
        .mockResolvedValueOnce(1) // transition
        .mockResolvedValueOnce(1); // heldQty release
      tx.stockHold.findMany.mockResolvedValue([
        { id: 'hold-1', productId: 'product-1', quantity: 3 },
      ]);
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        status: 'PAYMENT_REJECTED',
        updatedAt: new Date('2026-09-24T18:10:00.000Z'),
      });

      const result = await service.rejectPayment('order-1', ADMIN);

      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: 'PENDING_VERIFICATION',
          toStatus: 'PAYMENT_REJECTED',
          actorType: 'ADMIN',
          adminUserId: ADMIN.id,
        }) as unknown,
      });
      expect(tx.stockHold.update).toHaveBeenCalledWith({
        where: { id: 'hold-1' },
        data: { releasedAt: expect.any(Date) as unknown },
      });
      expect(result).toEqual({
        orderId: 'order-1',
        status: 'payment_rejected',
        updatedAt: '2026-09-24T18:10:00.000Z',
      });
    });

    it('409 ORDER_NOT_PENDING_VERIFICATION when the guarded transition affects 0 rows (duplicate/double-click reject — explicit conflict, never a silent no-op)', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1' })
        .mockResolvedValueOnce({ status: 'PAYMENT_REJECTED' });
      tx.$executeRaw.mockResolvedValueOnce(0);

      await expect(
        service.rejectPayment('order-1', ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'ORDER_NOT_PENDING_VERIFICATION',
          details: { currentStatus: 'payment_rejected' },
        },
      });
      expect(tx.stockHold.findMany).not.toHaveBeenCalled();
    });

    it('409 STOCK_HOLD_RELEASE_CONFLICT when the heldQty-only guard affects 0 rows', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1' });
      tx.$executeRaw
        .mockResolvedValueOnce(1) // transition succeeds
        .mockResolvedValueOnce(0); // heldQty release guard fails
      tx.stockHold.findMany.mockResolvedValue([
        { id: 'hold-1', productId: 'product-1', quantity: 3 },
      ]);

      await expect(
        service.rejectPayment('order-1', ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'STOCK_HOLD_RELEASE_CONFLICT',
          details: { productId: 'product-1' },
        },
      });
      expect(tx.stockHold.update).not.toHaveBeenCalled();
    });
  });
});
