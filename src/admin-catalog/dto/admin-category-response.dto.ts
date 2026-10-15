import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicCategoryResponseDto } from '../../catalog/dto/category-response.dto.js';

export class AdminCategoryCountDto {
  @ApiProperty({
    description:
      'DISTINCT Products linked to this Category (main `categoryId`; tags are added by Story 13.5).',
  })
  products: number;
}

/**
 * Story 13.2 (FR-46, FR-48; AD-35). Admin shape of a Category: the public
 * `CategoryResponseDto` plus the taxonomy fields (additive only — `id`,
 * `name`, `slug` are unchanged) and the product count.
 */
export class AdminCategoryResponseDto extends PublicCategoryResponseDto {
  @ApiPropertyOptional({ type: AdminCategoryCountDto })
  _count?: AdminCategoryCountDto;
}
