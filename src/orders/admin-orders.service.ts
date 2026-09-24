import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Order } from '../generated/prisma/client.js';
import type { OrderStatus, PaymentRail } from '../generated/prisma/enums.js';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto.js';
import { AdminOrderListItemDto } from './dto/admin-order-list-item.dto.js';
import {
  AdminOrdersPaginationMetaDto,
  PaginatedAdminOrdersResponseDto,
} from './dto/paginated-admin-orders-response.dto.js';

/**
 * Story 9.1 (FR-26, NFR-4; AD-11, AD-14). Read-only query over the
 * existing `Order` table (Epic 4/5) — no new tables, no schema changes
 * (this story's own Technical Notes). Lives in `OrdersModule` alongside
 * the buyer-facing `OrderLookupService`, per AD-14's explicit "one Orders
 * module, not a separate AdminOrders module" rule — see
 * `orders.module.ts`'s own doc comment for the wiring this requires.
 *
 * Uses Prisma's typed query builder (`Prisma.OrderWhereInput`) rather than
 * `CatalogService.listProducts`'s hand-written raw SQL (Story 2.2): that
 * raw-SQL detour existed specifically so `search` could use the pg_trgm
 * `%` similarity operator, which Postgres has no query-builder-native way
 * to express. This story has no free-text search AC — every filter here
 * (`status`, `paymentRail`) is a plain equality match Prisma's own builder
 * already parametrizes safely — so the added complexity of raw SQL buys
 * nothing. The combinable-AND-filters-plus-pagination *shape* is still the
 * same pattern Story 2.2 established, just expressed through the
 * type-checked builder instead.
 */
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(
    query: ListAdminOrdersQueryDto,
  ): Promise<PaginatedAdminOrdersResponseDto> {
    const { page, limit, sortOrder } = query;
    const offset = (page - 1) * limit;

    // Story 9.1 AC2/AC3: `status`/`paymentRail` combine with AND semantics
    // (both added to the same `where`, never OR'd) — identical criterion to
    // Story 2.2's combinable catalog filters. Each wire value was already
    // validated against `AdminOrderStatusFilter`/`AdminOrderPaymentRailFilter`
    // by `ListAdminOrdersQueryDto`'s `@IsEnum` decorators (a stable 400 for
    // anything else, NFR-4) before this method ever runs — `.toUpperCase()`
    // is a safe plain string transform here only because every member of
    // those wire enums is spelled as the exact lowercase of its `OrderStatus`/
    // `PaymentRail` Prisma counterpart (see that DTO's own doc comment).
    const where: Prisma.OrderWhereInput = {};
    if (query.status) {
      where.status = query.status.toUpperCase() as OrderStatus;
    }
    if (query.paymentRail) {
      where.paymentRail = query.paymentRail.toUpperCase() as PaymentRail;
    }

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: offset,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const data: AdminOrderListItemDto[] = rows.map((order) =>
      this.toListItemDto(order),
    );

    const meta: AdminOrdersPaginationMetaDto = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };

    return { data, meta };
  }

  private toListItemDto(order: Order): AdminOrderListItemDto {
    return {
      orderId: order.id,
      status: order.status.toLowerCase(),
      paymentRail: order.paymentRail.toLowerCase(),
      fulfillmentType: order.fulfillmentType.toLowerCase(),
      recipientName: order.recipientName,
      totalUsd: Number(order.totalUsd),
      totalVes: order.totalVes !== null ? Number(order.totalVes) : null,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}
