import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  Order,
  OrderLine,
  OrderStatusHistory,
} from '../generated/prisma/client.js';
import {
  OrderDetailResponseDto,
  OrderFulfillmentDto,
  OrderLookupLineDto,
  OrderStatusHistoryEntryDto,
} from './dto/order-lookup-response.dto.js';

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
      include: { lines: { orderBy: { createdAt: 'asc' } } },
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

  private toDetailDto(
    order: Order & { lines: OrderLine[] },
  ): OrderDetailResponseDto {
    const fulfillment: OrderFulfillmentDto = {
      type: order.fulfillmentType.toLowerCase(),
      recipientName: order.recipientName,
      recipientPhone: order.recipientPhone,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      city: order.city,
      state: order.state,
      country: order.country,
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
