import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import {
  CategoryDimension,
  CategoryType,
} from '../../generated/prisma/enums.js';

/**
 * Story 13.3 (FR-47; AD-35). Query of the public `GET /api/v1/categories`.
 * All filters AND together; invalid or repeated values give 400.
 */
export class ListCategoriesQueryDto {
  @ApiPropertyOptional({ enum: CategoryType, enumName: 'CategoryType' })
  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;

  @ApiPropertyOptional({
    enum: CategoryDimension,
    enumName: 'CategoryDimension',
  })
  @IsOptional()
  @IsEnum(CategoryDimension)
  dimension?: CategoryDimension;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only direct children of this parent.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
