import { Test, TestingModule } from '@nestjs/testing';
import { AdminOrdersService } from './admin-orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AdminOrderPaymentRailFilter,
  AdminOrderStatusFilter,
  AdminOrdersSortOrder,
  ListAdminOrdersQueryDto,
} from './dto/list-admin-orders-query.dto.js';

function buildQuery(
  overrides: Partial<ListAdminOrdersQueryDto> = {},
): ListAdminOrdersQueryDto {
  const query = new ListAdminOrdersQueryDto();
  Object.assign(query, overrides);
  return query;
}

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'PENDING_VERIFICATION',
    paymentRail: 'PAGO_MOVIL',
    fulfillmentType: 'PICKUP',
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    country: null,
    totalUsd: '179.98',
    fxRateVesPerUsd: '40.5000',
    totalVes: '7289.19',
    accessTokenHash: 'hash',
    paypalOrderId: null,
    createdAt: new Date('2026-09-24T17:41:08.000Z'),
    updatedAt: new Date('2026-09-24T17:45:12.000Z'),
    ...overrides,
  };
}

// Story 9.1 (FR-26, NFR-4). Unit-level branch coverage over
// `AdminOrdersService.listOrders`'s combinable-filter/pagination/sorting
// logic against a mocked PrismaService — the real end-to-end wiring
// (AdminAuthGuard gating, real Postgres) lives in
// `test/admin-orders.e2e-spec.ts`, same split `CatalogService`/
// `catalog.service.spec.ts` already established.
describe('AdminOrdersService', () => {
  let service: AdminOrdersService;
  let prisma: {
    order: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminOrdersService>(AdminOrdersService);
  });

  it('no filters: queries with an empty where, orders by createdAt desc by default, and maps rows to the list-item DTO shape', async () => {
    const order = buildOrder();
    prisma.order.findMany.mockResolvedValue([order]);
    prisma.order.count.mockResolvedValue(1);

    const result = await service.listOrders(buildQuery());

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: AdminOrdersSortOrder.DESC },
      skip: 0,
      take: 20,
    });
    expect(prisma.order.count).toHaveBeenCalledWith({ where: {} });
    expect(result.data).toEqual([
      {
        orderId: order.id,
        status: 'pending_verification',
        paymentRail: 'pago_movil',
        fulfillmentType: 'pickup',
        recipientName: 'Maria Perez',
        totalUsd: 179.98,
        totalVes: 7289.19,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
      },
    ]);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });

  it('a paypal Order (totalVes null): mapped through untouched, never coerced to 0', async () => {
    const order = buildOrder({
      paymentRail: 'PAYPAL',
      fxRateVesPerUsd: null,
      totalVes: null,
    });
    prisma.order.findMany.mockResolvedValue([order]);
    prisma.order.count.mockResolvedValue(1);

    const result = await service.listOrders(buildQuery());

    expect(result.data[0].totalVes).toBeNull();
    expect(result.data[0].paymentRail).toBe('paypal');
  });

  it('status=pending_verification: maps the lowercase wire value onto the uppercase Prisma enum in the where clause', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await service.listOrders(
      buildQuery({ status: AdminOrderStatusFilter.PENDING_VERIFICATION }),
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PENDING_VERIFICATION' } }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { status: 'PENDING_VERIFICATION' },
    });
  });

  it('paymentRail=paypal: maps the lowercase wire value onto the uppercase Prisma enum', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await service.listOrders(
      buildQuery({ paymentRail: AdminOrderPaymentRailFilter.PAYPAL }),
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentRail: 'PAYPAL' } }),
    );
  });

  it('status + paymentRail combined: both land in the same where (AND), never OR', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await service.listOrders(
      buildQuery({
        status: AdminOrderStatusFilter.PAID,
        paymentRail: AdminOrderPaymentRailFilter.PAYPAL,
      }),
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PAID', paymentRail: 'PAYPAL' },
      }),
    );
  });

  it('sortOrder=asc: passed straight through to orderBy.createdAt', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await service.listOrders(
      buildQuery({ sortOrder: AdminOrdersSortOrder.ASC }),
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
    );
  });

  it('pagination: page/limit drive skip/take, and totalPages is ceil(total/limit)', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(45);

    const result = await service.listOrders(buildQuery({ page: 3, limit: 20 }));

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
    expect(result.meta).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('no matches: returns an empty page (never throws), total 0 and totalPages 0', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    const result = await service.listOrders(buildQuery());

    expect(result.data).toEqual([]);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });
});
