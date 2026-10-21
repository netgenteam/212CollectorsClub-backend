import { ApiProperty } from '@nestjs/swagger';
import { OrderDetailResponseDto } from './order-lookup-response.dto.js';

/**
 * Story 15.2: the catalog `PaginationMetaDto` gained `hasNextPage` /
 * `hasPreviousPage`; the customer-orders list keeps its original four-field
 * meta (this endpoint is out of scope for 15.2), so it owns its own DTO.
 */
export class CustomerOrdersPaginationMetaDto {
  @ApiProperty({ example: 1, description: '1-based current page.' })
  page: number;

  @ApiProperty({ example: 20, description: 'Items per page.' })
  limit: number;

  @ApiProperty({ example: 11, description: 'Total Orders of the customer.' })
  total: number;

  @ApiProperty({ example: 1, description: 'Total pages.' })
  totalPages: number;
}

/** Story 12.6: same `{data, meta}` envelope as the catalog list. */
export class PaginatedCustomerOrdersResponseDto {
  @ApiProperty({ type: [OrderDetailResponseDto] })
  data: OrderDetailResponseDto[];

  @ApiProperty({ type: CustomerOrdersPaginationMetaDto })
  meta: CustomerOrdersPaginationMetaDto;
}
