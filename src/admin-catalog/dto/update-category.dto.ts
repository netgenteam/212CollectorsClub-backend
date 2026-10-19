import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CategoryDimension,
  CategoryType,
} from '../../generated/prisma/enums.js';

/**
 * Story 8.1 (FR-23). Body of `PATCH /api/v1/admin/categories/:id`. Both
 * fields are optional (a partial update) — `name`-only and `slug`-only
 * requests are both legal; omitting both simply leaves the Category
 * unchanged. Same `slug` shape/uniqueness rules as `CreateCategoryDto` (see
 * its own doc comment) apply whenever `slug` IS supplied.
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({
    example: 'Cartas Sueltas Premium',
    description: 'New display name. Omit to leave the current name unchanged.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: 'cartas-sueltas-premium',
    description:
      'New URL-safe, unique slug (same shape as CreateCategoryDto.slug). Omit to leave the current slug unchanged.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas")',
  })
  slug?: string;

  @ApiPropertyOptional({
    enum: CategoryType,
    enumName: 'CategoryType',
    description:
      'ROOT (no dimension/parent) or SUBCATEGORY (requires parentId or dimension). Defaults to ROOT on create.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(CategoryType)
  type?: CategoryType;

  @ApiPropertyOptional({
    enum: CategoryDimension,
    enumName: 'CategoryDimension',
    nullable: true,
    description:
      'Taxonomy dimension. Optional for SUBCATEGORY with a parentId (persisted as null when omitted); a SUBCATEGORY without parentId requires it; forbidden for ROOT. `null` clears it (PATCH).',
  })
  @IsOptional()
  @IsEnum(CategoryDimension)
  dimension?: CategoryDimension | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Parent Category id (ROOT or SUBCATEGORY). Max tree depth is 3. `null` clears it (PATCH).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({
    description: 'Whether the Category is active. Defaults to true on create.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100000,
    description: 'Display order (ascending). Defaults to 0 on create.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}
