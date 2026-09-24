import { Test, TestingModule } from '@nestjs/testing';
import { PaymentProcessingTimeoutCronService } from './payment-processing-timeout-cron.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Story 5.2: unit-level coverage of `runTimeoutCheck`'s own candidate
 * selection + conflict-skip branching, mirroring
 * `StockHoldExpiryCronService`'s own spec — `PrismaService` mocked the
 * same way `CheckoutService`'s spec mocks it. Full real-Postgres coverage
 * (the actual `payment_failed` transition, the 30-minute cutoff against a
 * real `createdAt`, idempotency across two real cron runs) lives in
 * `test/order-lifecycle-crons.e2e-spec.ts`.
 */
describe('PaymentProcessingTimeoutCronService', () => {
  let service: PaymentProcessingTimeoutCronService;
  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    order: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: vi.fn(),
      orderStatusHistory: { create: vi.fn() },
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      order: { findMany: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessingTimeoutCronService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PaymentProcessingTimeoutCronService>(
      PaymentProcessingTimeoutCronService,
    );
  });

  it('no stale payment_processing Orders: returns all-zero counts and never opens a transaction', async () => {
    prisma.order.findMany.mockResolvedValue([]);

    const result = await service.runTimeoutCheck();

    expect(result).toEqual({ ordersFailed: 0, ordersSkippedConflict: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('queries only PAYMENT_PROCESSING Orders older than the 30-minute cutoff', async () => {
    prisma.order.findMany.mockResolvedValue([]);

    await service.runTimeoutCheck();

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PAYMENT_PROCESSING',
        createdAt: { lte: expect.any(Date) as unknown },
      },
      select: { id: true },
    });
  });

  it('a stale Order transitions payment_processing -> payment_failed, never touching stock', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }]);
    tx.$executeRaw.mockResolvedValueOnce(1);

    const result = await service.runTimeoutCheck();

    expect(result).toEqual({ ordersFailed: 1, ordersSkippedConflict: 0 });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        fromStatus: 'PAYMENT_PROCESSING',
        toStatus: 'PAYMENT_FAILED',
        actorType: 'CRON',
      }) as unknown,
    });
  });

  it('a candidate Order already resolved by the time its transaction runs (guard affects 0 rows): safe skip, no history written', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }]);
    tx.$executeRaw.mockResolvedValueOnce(0);

    const result = await service.runTimeoutCheck();

    expect(result).toEqual({ ordersFailed: 0, ordersSkippedConflict: 1 });
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('processes multiple stale Orders independently — one conflict does not stop the others', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-1' },
      { id: 'order-2' },
    ]);
    tx.$executeRaw
      .mockResolvedValueOnce(0) // order-1: already resolved
      .mockResolvedValueOnce(1); // order-2: succeeds

    const result = await service.runTimeoutCheck();

    expect(result).toEqual({ ordersFailed: 1, ordersSkippedConflict: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
