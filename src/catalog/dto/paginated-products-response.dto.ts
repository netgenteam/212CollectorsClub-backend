import { ApiProperty } from '@nestjs/swagger';
import { ProductListItemDto } from './product-list-item.dto.js';

export class PaginationMetaDto {
  @ApiProperty({ example: 1, description: '1-based current page.' })
  page: number;

  @ApiProperty({ example: 20, description: 'Items per page.' })
  limit: number;

  @ApiProperty({
    example: 11,
    description: 'Total items matching the filters/search.',
  })
  total: number;

  @ApiProperty({
    example: 1,
    description: 'Total pages for this filter/search combination.',
  })
  totalPages: number;
}

/**
 * Story 2.2 (FR-6): the always-200 paginated envelope for
 * `GET /api/v1/products` — a no-match filter/search combination returns
 * this same shape with an empty `data` array and `total: 0`, never an
 * error (explicit AC).
 */
export class PaginatedProductsResponseDto {
  @ApiProperty({ type: ProductListItemDto, isArray: true })
  data: ProductListItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
