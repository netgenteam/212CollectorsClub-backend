import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AdminOrderPaymentRailFilter,
  AdminOrderStatusFilter,
  AdminOrdersSortOrder,
  DEFAULT_ADMIN_ORDERS_LIMIT,
  DEFAULT_ADMIN_ORDERS_PAGE,
  MAX_ADMIN_ORDERS_LIMIT,
} from './list-admin-orders-query.dto.js';

/**
 * Story 20.4 (FR-124, FR-126, NFR-20.5): body of `POST /admin/orders/search`.
 *
 * The cedula travels in the BODY, never in a URL: a URL is written by proxies and by the web
 * server's `error_log` (which prints the whole request line on any upstream failure). It is the
 * same reason `reveal-id-doc` takes `field` in the body. Pagination and filters are the ones of
 * `GET /admin/orders`, with the same defaults and limits (JSON types: numbers and booleans, not
 * strings). Unknown properties are 400 (`strictBody`).
 */
export class SearchAdminOrdersDto {
  @ApiProperty({
    example: 'V-12345678',
    maxLength: 30,
    description:
      'Exact ID document search (recipient OR buyer), by blind index. Accepts V12345678, v-12.345.678... Equality only: no partial match, no LIKE. A value that is not a complete valid ID is 400 ID_DOC_FILTER_INVALID (the value is never echoed); no match is an empty page. The value is never logged.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  idDoc: string;

  @ApiPropertyOptional({
    minimum: 1,
    default: DEFAULT_ADMIN_ORDERS_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
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
  @IsInt()
  @Min(1)
  @Max(MAX_ADMIN_ORDERS_LIMIT)
  limit: number = DEFAULT_ADMIN_ORDERS_LIMIT;

  @ApiPropertyOptional({
    enum: AdminOrderStatusFilter,
    description: 'Same as GET /admin/orders. Combinable (AND).',
  })
  @IsOptional()
  @IsEnum(AdminOrderStatusFilter)
  status?: AdminOrderStatusFilter;

  @ApiPropertyOptional({
    enum: AdminOrderPaymentRailFilter,
    description: 'Same as GET /admin/orders. Combinable (AND).',
  })
  @IsOptional()
  @IsEnum(AdminOrderPaymentRailFilter)
  paymentRail?: AdminOrderPaymentRailFilter;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Same as GET /admin/orders (Story 14.5b).',
  })
  @IsOptional()
  @IsBoolean()
  refundPending?: boolean;

  @ApiPropertyOptional({
    enum: AdminOrdersSortOrder,
    default: AdminOrdersSortOrder.DESC,
    description: 'Sort by Order.createdAt (default "desc").',
  })
  @IsOptional()
  @IsEnum(AdminOrdersSortOrder)
  sortOrder: AdminOrdersSortOrder = AdminOrdersSortOrder.DESC;
}
