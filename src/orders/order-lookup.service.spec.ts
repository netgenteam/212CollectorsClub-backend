import { OrderLookupService } from './order-lookup.service.js';
import {
  FulfillmentType,
  OrderActorType,
  OrderStatus,
  PaymentRail,
} from '../generated/prisma/enums.js';

function buildOrderWithLines(
  overrides: Partial<{
    id: string;
    status: OrderStatus;
    paymentRail: PaymentRail;
    fulfillmentType: FulfillmentType;
    fxRateVesPerUsd: unknown;
    totalVes: unknown;
  }> = {},
) {
  return {
    id: overrides.id ?? 'order-1',
    status: overrides.status ?? OrderStatus.PENDING_VERIFICATION,
    paymentRail: overrides.paymentRail ?? PaymentRail.PAGO_MOVIL,
    fulfillmentType: overrides.fulfillmentType ?? FulfillmentType.DELIVERY,
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    addressLine1: 'Av. Francisco de Miranda',
    addressLine2: null,
    city: 'Caracas',
    state: 'Distrito Capital',
    country: 'Venezuela',
    totalUsd: { toString: () => '179.98' } as never,
    fxRateVesPerUsd:
      overrides.fxRateVesPerUsd === undefined
        ? ({ toString: () => '40.5000' } as never)
        : overrides.fxRateVesPerUsd,
    totalVes:
      overrides.totalVes === undefined
        ? ({ toString: () => '7289.19' } as never)
        : overrides.totalVes,
    createdAt: new Date('2026-09-24T17:41:08.000Z'),
    updatedAt: new Date('2026-09-24T17:45:12.000Z'),
    lines: [
      {
        productId: 'product-1',
        productName: 'Charizard VMAX',
        unitPriceUsd: { toString: () => '89.99' } as never,
        quantity: 2,
        lineTotalUsd: { toString: () => '179.98' } as never,
      },
    ],
  };
}

describe('OrderLookupService', () => {
  let prisma: {
    order: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
    orderStatusHistory: { findMany: ReturnType<typeof vi.fn> };
  };
  let service: OrderLookupService;

  beforeEach(() => {
    prisma = {
      order: { findUniqueOrThrow: vi.fn() },
      orderStatusHistory: { findMany: vi.fn() },
    };
    service = new OrderLookupService(prisma as never);
  });

  describe('getDetail', () => {
    it('maps the Order + lines into the lowercased, buyer-facing detail DTO', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue(buildOrderWithLines());

      const result = await service.getDetail('order-1');

      expect(prisma.order.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        include: { lines: { orderBy: { createdAt: 'asc' } } },
      });
      expect(result).toEqual({
        orderId: 'order-1',
        status: 'pending_verification',
        paymentRail: 'pago_movil',
        fulfillment: {
          type: 'delivery',
          recipientName: 'Maria Perez',
          recipientPhone: '0412-1234567',
          addressLine1: 'Av. Francisco de Miranda',
          addressLine2: null,
          city: 'Caracas',
          state: 'Distrito Capital',
          country: 'Venezuela',
        },
        totalUsd: 179.98,
        fxRateVesPerUsd: 40.5,
        totalVes: 7289.19,
        lines: [
          {
            productId: 'product-1',
            productName: 'Charizard VMAX',
            unitPriceUsd: 89.99,
            quantity: 2,
            lineTotalUsd: 179.98,
          },
        ],
        createdAt: '2026-09-24T17:41:08.000Z',
        updatedAt: '2026-09-24T17:45:12.000Z',
      });
    });

    it('keeps fxRateVesPerUsd/totalVes null for a stripe Order (AD-3), never coerced to 0', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        buildOrderWithLines({
          paymentRail: PaymentRail.STRIPE,
          fulfillmentType: FulfillmentType.PICKUP,
          fxRateVesPerUsd: null,
          totalVes: null,
        }),
      );

      const result = await service.getDetail('order-1');

      expect(result.paymentRail).toBe('stripe');
      expect(result.fulfillment.type).toBe('pickup');
      expect(result.fxRateVesPerUsd).toBeNull();
      expect(result.totalVes).toBeNull();
    });
  });

  describe('getHistory', () => {
    it('returns every OrderStatusHistory row, oldest first, with actorType/status lowercased', async () => {
      prisma.orderStatusHistory.findMany.mockResolvedValue([
        {
          fromStatus: null,
          toStatus: OrderStatus.PENDING_VERIFICATION,
          actorType: OrderActorType.SYSTEM,
          createdAt: new Date('2026-09-24T17:41:08.000Z'),
        },
        {
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.PAID,
          actorType: OrderActorType.ADMIN,
          createdAt: new Date('2026-09-24T18:00:00.000Z'),
        },
      ]);

      const result = await service.getHistory('order-1');

      expect(prisma.orderStatusHistory.findMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual([
        {
          fromStatus: null,
          toStatus: 'pending_verification',
          actorType: 'system',
          createdAt: '2026-09-24T17:41:08.000Z',
        },
        {
          fromStatus: 'pending_verification',
          toStatus: 'paid',
          actorType: 'admin',
          createdAt: '2026-09-24T18:00:00.000Z',
        },
      ]);
    });

    it('returns a single-row array (never empty) for an Order that never transitioned past creation', async () => {
      prisma.orderStatusHistory.findMany.mockResolvedValue([
        {
          fromStatus: null,
          toStatus: OrderStatus.PAYMENT_PROCESSING,
          actorType: OrderActorType.SYSTEM,
          createdAt: new Date('2026-09-24T17:41:08.000Z'),
        },
      ]);

      const result = await service.getHistory('order-1');

      expect(result).toHaveLength(1);
      expect(result[0].fromStatus).toBeNull();
      expect(result[0].toStatus).toBe('payment_processing');
    });
  });
});

/** Story 12.6 (FR-45): "mis pedidos" queries filter by owner in the WHERE. */
describe('OrderLookupService (customer orders)', () => {
  const order = buildOrderWithLines();

  it('listForCustomer: WHERE customerId, newest first, catalog-style meta', async () => {
    const prisma = {
      order: {
        count: vi.fn().mockResolvedValue(45),
        findMany: vi.fn().mockResolvedValue([order]),
      },
    };
    const service = new OrderLookupService(prisma as never);
    const res = await service.listForCustomer('c1', 2, 20);
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { customerId: 'c1' },
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'c1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
      }),
    );
    expect(res.meta).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(res.data[0].orderId).toBe('order-1');
  });

  it('getDetailForCustomer: filters id AND customerId in one query; no match -> 404', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new OrderLookupService({ order: { findFirst } } as never);
    await expect(
      service.getDetailForCustomer('c1', 'o1'),
    ).rejects.toMatchObject({
      status: 404,
      response: { errorCode: 'ORDER_NOT_FOUND' },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', customerId: 'c1' } }),
    );
  });

  it('getDetailForCustomer: same shape as lookup plus statusHistory', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      ...order,
      statusHistory: [
        {
          fromStatus: null,
          toStatus: OrderStatus.PENDING_VERIFICATION,
          actorType: OrderActorType.SYSTEM,
          createdAt: new Date('2026-09-24T17:41:08.000Z'),
        },
      ],
    });
    const service = new OrderLookupService({ order: { findFirst } } as never);
    const res = await service.getDetailForCustomer('c1', 'order-1');
    expect(res.statusHistory).toEqual([
      {
        fromStatus: null,
        toStatus: 'pending_verification',
        actorType: 'system',
        createdAt: '2026-09-24T17:41:08.000Z',
      },
    ]);
    expect(res.lines).toHaveLength(1);
  });
});
