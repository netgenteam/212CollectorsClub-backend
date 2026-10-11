import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../catalog/dto/paginated-products-response.dto.js';
import { OrderDetailResponseDto } from './order-lookup-response.dto.js';

/** Story 12.6: same `{data, meta}` envelope as the catalog list. */
export class PaginatedCustomerOrdersResponseDto {
  @ApiProperty({ type: [OrderDetailResponseDto] })
  data: OrderDetailResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
