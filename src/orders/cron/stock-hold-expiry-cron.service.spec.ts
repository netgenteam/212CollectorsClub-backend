import { Test, TestingModule } from '@nestjs/testing';
import {
  HeldQtyReleaseConflictError,
  StockHoldExpiryCronService,
} from './stock-hold-expiry-cron.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Story 5.2: unit-level coverage of `runExpiryCheck`'s own candidate
 * selection + per-order branching logic (skip-on-conflict,
 * flag-on-heldQty-conflict), with `PrismaService` mocked exactly the way
 * `CheckoutService`'s own spec mocks it (`$transaction` invokes the real
 * callback against a mocked `tx`). `guardedOrderStatusTransition` and
 * `executeGuardedUpdate` themselves are NOT mocked — they're the real,
 * already-unit-tested (`order-status-transition.spec.ts`) implementations,
 * driven here purely via `tx.$executeRaw`'s scripted return values. Full
 * real-Postgres coverage (the actual heldQty decrement, the actual
 * `expired` transition, idempotency across two real cron runs) lives in
 * `test/order-lifecycle-crons.e2e-spec.ts`.
 */
describe('StockHoldExpiryCronService', () => {
  let service: StockHoldExpiryCronService;
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
    stockHold: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: vi.fn(),
      orderStatusHistory: { create: vi.fn() },
      stockHold: { findMany: vi.fn(), update: vi.fn() },
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      stockHold: { findMany: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockHoldExpiryCronService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<StockHoldExpiryCronService>(
      StockHoldExpiryCronService,
    );
  });

  it('no expired holds for a still-pending Order: returns all-zero counts and never opens a transaction', async () => {
    prisma.stockHold.findMany.mockResolvedValue([]);

    const result = await service.runExpiryCheck();

    expect(result).toEqual({
      ordersExpired: 0,
      ordersSkippedConflict: 0,
      ordersFlaggedForReconciliation: 0,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('expires an Order with one expired hold: guarded UPDATE releases heldQty, the hold is marked released, and the Order transitions to expired', async () => {
    prisma.stockHold.findMany.mockResolvedValue([{ orderId: 'order-1' }]);
    tx.$executeRaw
      .mockResolvedValueOnce(1) // guardedOrderStatusTransition's UPDATE "Orders"
      .mockResolvedValueOnce(1); // heldQty release UPDATE "Products"
    tx.stockHold.findMany.mockResolvedValue([
      { id: 'hold-1', productId: 'product-1', quantity: 2 },
    ]);

    const result = await service.runExpiryCheck();

    expect(result).toEqual({
      ordersExpired: 1,
      ordersSkippedConflict: 0,
      ordersFlaggedForReconciliation: 0,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        fromStatus: 'PENDING_VERIFICATION',
        toStatus: 'EXPIRED',
        actorType: 'CRON',
      }) as unknown,
    });
    expect(tx.stockHold.update).toHaveBeenCalledWith({
      where: { id: 'hold-1' },
      data: { releasedAt: expect.any(Date) as unknown },
    });
  });

  it('a candidate Order already resolved by the time its transaction runs (guard affects 0 rows): safe skip, no heldQty touched, no history written', async () => {
    prisma.stockHold.findMany.mockResolvedValue([{ orderId: 'order-1' }]);
    tx.$executeRaw.mockResolvedValueOnce(0); // guardedOrderStatusTransition's UPDATE matches 0 rows

    const result = await service.runExpiryCheck();

    expect(result).toEqual({
      ordersExpired: 0,
      ordersSkippedConflict: 1,
      ordersFlaggedForReconciliation: 0,
    });
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.stockHold.findMany).not.toHaveBeenCalled();
    expect(tx.stockHold.update).not.toHaveBeenCalled();
  });

  it('the Order transition succeeds but the heldQty release guard affects 0 rows: flagged for reconciliation, the hold is never marked released', async () => {
    prisma.stockHold.findMany.mockResolvedValue([{ orderId: 'order-1' }]);
    tx.$executeRaw
      .mockResolvedValueOnce(1) // order transition succeeds
      .mockResolvedValueOnce(0); // heldQty release guard affects 0 rows
    tx.stockHold.findMany.mockResolvedValue([
      { id: 'hold-1', productId: 'product-1', quantity: 2 },
    ]);

    const result = await service.runExpiryCheck();

    expect(result).toEqual({
      ordersExpired: 0,
      ordersSkippedConflict: 0,
      ordersFlaggedForReconciliation: 1,
    });
    expect(tx.stockHold.update).not.toHaveBeenCalled();
  });

  it('HeldQtyReleaseConflictError carries the orderId/productId/stockHoldId for the manual-reconciliation log', () => {
    const err = new HeldQtyReleaseConflictError(
      'order-1',
      'product-1',
      'hold-1',
    );
    expect(err.orderId).toBe('order-1');
    expect(err.productId).toBe('product-1');
    expect(err.stockHoldId).toBe('hold-1');
  });

  it('deduplicates multiple expired-hold rows for the SAME Order into a single expiry attempt', async () => {
    prisma.stockHold.findMany.mockResolvedValue([
      { orderId: 'order-1' },
      { orderId: 'order-1' },
    ]);
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    tx.stockHold.findMany.mockResolvedValue([
      { id: 'hold-1', productId: 'product-1', quantity: 1 },
    ]);

    const result = await service.runExpiryCheck();

    expect(result.ordersExpired).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
