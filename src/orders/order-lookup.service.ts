import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { buildTrackingUrl } from '../shipping/tracking-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  Order,
  OrderLine,
  OrderStatusHistory,
} from '../generated/prisma/client.js';
import type { PaginatedCustomerOrdersResponseDto } from './dto/paginated-customer-orders-response.dto.js';
import {
  CustomerOrderDetailResponseDto,
  OrderDetailResponseDto,
  OrderFulfillmentDto,
  OrderLookupLineDto,
  OrderStatusHistoryEntryDto,
} from './dto/order-lookup-response.dto.js';

/**
 * Story 17.5 (AD-75): one JOIN brings the agency in for detail and list
 * queries (no N+1). `trackingUrlTemplate` is read only to build `trackingUrl`
 * and is dropped before serialization.
 */
const ORDER_INCLUDE = {
  lines: { orderBy: { createdAt: 'asc' } },
  shippingAgency: {
    select: { name: true, code: true, trackingUrlTemplate: true },
  },
} as const;

type OrderWithRelations = Order & {
  lines: OrderLine[];
  shippingAgency: {
    name: string;
    code: string;
    trackingUrlTemplate: string | null;
  } | null;
};

/**
 * Story 5.1 (FR-13 retrievability, FR-17; AD-17, AD-7). Pure read-side
 * service — `OrderLookupController` gates every call here with the exact
 * same `OrderAccessTokenGuard` Story 4.2 introduced, so by the time either
 * method runs the caller has already been proven to hold the
 * `orderAccessToken` for this specific `orderId`; nothing here re-checks
 * authorization.
 *
 * **Admin auth gap (7.1/7.2)**: the story's AC also says this data should
 * be reachable "by an authenticated Admin", but Admin auth (JWT, Stories
 * 7.1/7.2) does not exist yet in this codebase as of Sprint 3 — see
 * `OrderLookupController`'s own doc comment for where that gap is flagged
 * in full. This service is deliberately written to take a plain `orderId`
 * string with no buyer-specific assumption baked in, so a future
 * admin-facing route can call `getDetail`/`getHistory` unchanged behind a
 * different guard — only the controller/guard layer needs to grow, not
 * this service.
 */
@Injectable()
export class OrderLookupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 5.1 AC1. `OrderAccessTokenGuard` itself only ever loads a bare
   * `Order` (no `lines`) to check the token — most routes behind it (e.g.
   * Story 4.2's proof-of-payment routes) never need line items, so that
   * join is deliberately not added there. This method re-reads the Order
   * WITH its lines instead of reusing the guard's bare row — the same
   * "guard authorizes, service reads what it actually needs" split Story
   * 4.2's `ProofOfPaymentService.getStatus` already established.
   */
  async getDetail(orderId: string): Promise<OrderDetailResponseDto> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    return this.toDetailDto(order);
  }

  /**
   * Story 5.1 AC2/AC3: every `OrderStatusHistory` row for this Order,
   * oldest first — never just the current state. `recordInitialOrderStatus`
   * (`common/order-status-transition.ts`) always writes the `[]->X`
   * creation row inside the SAME transaction as the Order's own creation
   * (Story 4.1's `CheckoutService`), so every real Order has at least that
   * one row — AC3's "never an empty array" is a structural guarantee from
   * that invariant, not something this method has to special-case.
   */
  async getHistory(orderId: string): Promise<OrderStatusHistoryEntryDto[]> {
    const rows = await this.prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toHistoryDto(row));
  }

  /**
   * Story 12.6 (FR-45, AD-31): the customer's own orders, newest first.
   * Ownership is part of the SQL `WHERE` (never fetch-then-compare).
   */
  async listForCustomer(
    customerId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedCustomerOrdersResponseDto> {
    const where = { customerId };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      data: rows.map((row) => this.toDetailDto(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  /**
   * Story 12.6: a foreign order, a guest order and an unknown id are the
   * SAME 404 (no enumeration) — one query filtered by id AND customerId.
   */
  async getDetailForCustomer(
    customerId: string,
    orderId: string,
  ): Promise<CustomerOrderDetailResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      include: {
        ...ORDER_INCLUDE,
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'ORDER_NOT_FOUND',
        'Order not found.',
      );
    }
    return {
      ...this.toDetailDto(order),
      statusHistory: order.statusHistory.map((row) => this.toHistoryDto(row)),
    };
  }

  private toDetailDto(order: OrderWithRelations): OrderDetailResponseDto {
    const fulfillment: OrderFulfillmentDto = {
      type: order.fulfillmentType.toLowerCase(),
      recipientName: order.recipientName,
      recipientPhone: order.recipientPhone,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      city: order.city,
      state: order.state,
      country: order.country,
      recipientIdDoc: order.recipientIdDoc,
      deliveryMode: order.deliveryMode
        ? order.deliveryMode.toLowerCase()
        : null,
      agencyBranchName: order.agencyBranchName,
      agencyBranchCode: order.agencyBranchCode,
      municipality: order.municipality,
      parish: order.parish,
      referencePoint: order.referencePoint,
      shippingAgency: order.shippingAgency
        ? { name: order.shippingAgency.name, code: order.shippingAgency.code }
        : null,
      trackingNumber: order.trackingNumber,
      trackingUrl: buildTrackingUrl(
        order.shippingAgency?.trackingUrlTemplate,
        order.trackingNumber,
      ),
    };

    const lines: OrderLookupLineDto[] = order.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      unitPriceUsd: Number(line.unitPriceUsd),
      quantity: line.quantity,
      lineTotalUsd: Number(line.lineTotalUsd),
    }));

    return {
      orderId: order.id,
      status: order.status.toLowerCase(),
      paymentRail: order.paymentRail.toLowerCase(),
      fulfillment,
      totalUsd: Number(order.totalUsd),
      fxRateVesPerUsd:
        order.fxRateVesPerUsd !== null ? Number(order.fxRateVesPerUsd) : null,
      totalVes: order.totalVes !== null ? Number(order.totalVes) : null,
      lines,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  private toHistoryDto(row: OrderStatusHistory): OrderStatusHistoryEntryDto {
    return {
      fromStatus: row.fromStatus !== null ? row.fromStatus.toLowerCase() : null,
      toStatus: row.toStatus.toLowerCase(),
      actorType: row.actorType.toLowerCase(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
