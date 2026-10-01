import { ApiProperty } from '@nestjs/swagger';
import { ProductListItemDto } from './product-list-item.dto.js';

/** Story 11.3 (FR-33): `{ data }` envelope, no `meta` (AD-20). */
export class RelatedProductsResponseDto {
  @ApiProperty({ type: () => [ProductListItemDto] })
  data: ProductListItemDto[];
}
