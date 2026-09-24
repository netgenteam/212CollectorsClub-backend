import { ApiProperty } from '@nestjs/swagger';
import { AdminOrderListItemDto } from './admin-order-list-item.dto.js';

/** Same shape as Story 2.2's `PaginationMetaDto` (`catalog/dto`) —
 * duplicated locally rather than imported cross-module, matching this
 * codebase's existing convention of each module owning its own DTOs even
 * when a shape happens to coincide with another module's (e.g.
 * `OrderLookupService`'s DTOs vs. `CheckoutResponseDto`). */
export class AdminOrdersPaginationMetaDto {
  @ApiProperty({ example: 1, description: '1-based current page.' })
  page: number;

  @ApiProperty({ example: 20, description: 'Items per page.' })
  limit: number;

  @ApiProperty({
    example: 11,
    description: 'Total Orders matching the given filters.',
  })
  total: number;

  @ApiProperty({
    example: 1,
    description: 'Total pages for this filter combination.',
  })
  totalPages: number;
}

/**
 * Story 9.1 AC1: the always-200 paginated envelope for
 * `GET /api/v1/admin/orders` — a no-match filter combination returns this
 * same shape with an empty `data` array and `total: 0`, never an error
 * (same "empty page over erroring" criterion Story 2.2's public Product
 * list already established).
 */
export class PaginatedAdminOrdersResponseDto {
  @ApiProperty({ type: AdminOrderListItemDto, isArray: true })
  data: AdminOrderListItemDto[];

  @ApiProperty({ type: AdminOrdersPaginationMetaDto })
  meta: AdminOrdersPaginationMetaDto;
}
