import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CategoryDimension,
  CategoryType,
} from '../../generated/prisma/enums.js';

/**
 * Story 13.2 (FR-48; AD-35). Query of `GET /api/v1/admin/categories`.
 * `search` and `q` match `name`/`slug` literally (case-insensitive); when
 * both are sent `search` wins. All filters AND together.
 */
export class ListAdminCategoriesQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Literal, case-insensitive match on name or slug.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Alias of `search` (ignored when `search` is present).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;
}
