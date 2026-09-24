import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_ADMIN_ORDERS_PAGE = 1;
export const DEFAULT_ADMIN_ORDERS_LIMIT = 20;
export const MAX_ADMIN_ORDERS_LIMIT = 100;

/**
 * Story 9.1 (FR-26, NFR-4; AD-14). Wire filter values are deliberately
 * lowercase-snake (`pending_verification`, not the Prisma `OrderStatus`
 * enum's `PENDING_VERIFICATION`) — the story's own Acceptance Criteria
 * spell them exactly that way (`status=pending_verification`), the same
 * "wire contract != internal Prisma enum" split `CheckoutDto`'s
 * `CheckoutPaymentRail`/`CheckoutFulfillmentType` already established for
 * this same `Order` model, and the same casing `OrderLookupService` already
 * emits on its way OUT (`order.status.toLowerCase()`). `AdminOrdersService`
 * maps a validated value here onto the real `OrderStatus` enum with a
 * plain `.toUpperCase()` — safe only because every member below is spelled
 * as the exact lowercase of its `OrderStatus` counterpart; never add a
 * value here that isn't.
 */
export enum AdminOrderStatusFilter {
  PAYMENT_PROCESSING = 'payment_processing',
  PENDING_VERIFICATION = 'pending_verification',
  PAID = 'paid',
  PAYMENT_FAILED = 'payment_failed',
  PAYMENT_REJECTED = 'payment_rejected',
  EXPIRED = 'expired',
  FULFILLED = 'fulfilled',
  CANCELLED = 'cancelled',
}

/**
 * Same lowercase-wire-vs-uppercase-Prisma-enum split as
 * `AdminOrderStatusFilter` above, and deliberately identical wire spelling
 * to `CheckoutPaymentRail` (`pago_movil`/`paypal`) — a story-9.1 filter
 * value round-trips through the exact same string a Story 4.1/4.3 checkout
 * request originally sent.
 */
export enum AdminOrderPaymentRailFilter {
  PAGO_MOVIL = 'pago_movil',
  PAYPAL = 'paypal',
}

export enum AdminOrdersSortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

/**
 * Story 9.1 AC1-AC3: query params for `GET /api/v1/admin/orders`. Every
 * field is optional and independently combinable with AND semantics — same
 * combinable-filter/pagination shape `ListProductsQueryDto` (Story 2.2)
 * established for the public Product list, minus the pg_trgm `search`
 * field (no free-text search AC here, Technical Notes explicitly scope
 * this to a read-only filter/paginate query). `class-validator` +
 * the global `ValidationPipe` (`src/common/global-validation-pipe.ts`)
 * turn any malformed value (e.g. `page=abc`, an out-of-enum `status`) into
 * a stable 400 before this ever reaches `AdminOrdersService` (NFR-4/NFR-3
 * pattern).
 */
export class ListAdminOrdersQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: DEFAULT_ADMIN_ORDERS_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = DEFAULT_ADMIN_ORDERS_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_ADMIN_ORDERS_LIMIT,
    default: DEFAULT_ADMIN_ORDERS_LIMIT,
    description: `Items per page (max ${MAX_ADMIN_ORDERS_LIMIT}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ADMIN_ORDERS_LIMIT)
  limit: number = DEFAULT_ADMIN_ORDERS_LIMIT;

  @ApiPropertyOptional({
    enum: AdminOrderStatusFilter,
    description:
      'Filter by the AD-7 Order status (lowercase wire value, e.g. pending_verification).',
  })
  @IsOptional()
  @IsEnum(AdminOrderStatusFilter)
  status?: AdminOrderStatusFilter;

  @ApiPropertyOptional({
    enum: AdminOrderPaymentRailFilter,
    description: 'Filter by payment rail. Combinable (AND) with status.',
  })
  @IsOptional()
  @IsEnum(AdminOrderPaymentRailFilter)
  paymentRail?: AdminOrderPaymentRailFilter;

  @ApiPropertyOptional({
    enum: AdminOrdersSortOrder,
    default: AdminOrdersSortOrder.DESC,
    description:
      'Sort by Order.createdAt. Defaults to "desc" (most recent first) so the daily reconciliation workflow (PRD UJ-5) sees new Orders first.',
  })
  @IsOptional()
  @IsEnum(AdminOrdersSortOrder)
  sortOrder: AdminOrdersSortOrder = AdminOrdersSortOrder.DESC;
}
