import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
 * Story 8.1 (FR-23, AD-2). Body of `POST /api/v1/admin/categories`.
 *
 * `slug` is validated as a URL-safe token (lowercase letters, digits,
 * single hyphens between segments — the exact shape every seeded Category
 * slug already follows, e.g. "cartas-sueltas") purely as an input-quality
 * gate at the DTO layer (NFR-3: malformed input never reaches Prisma).
 * *Uniqueness* is a separate concern this DTO cannot enforce — `Category.
 * slug` is `@unique` at the DB level (Story 1.4) and
 * `AdminCategoriesService.create` translates a `P2002` violation on it into
 * a stable `409 CATEGORY_SLUG_TAKEN`, never a raw 500.
 */
export class CreateCategoryDto {
  @ApiProperty({
    example: 'Cartas Sueltas',
    description: 'Display name shown to storefront buyers.',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'cartas-sueltas',
    description:
      'URL-safe, unique slug: lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas"). Must not already be in use by another Category.',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas")',
  })
  slug: string;

  @ApiPropertyOptional({
    enum: CategoryType,
    enumName: 'CategoryType',
    description:
      'ROOT (no dimension/parent) or SUBCATEGORY (requires dimension). Defaults to ROOT on create.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(CategoryType)
  type?: CategoryType;

  @ApiPropertyOptional({
    enum: CategoryDimension,
    enumName: 'CategoryDimension',
    nullable: true,
    description:
      'Taxonomy dimension. Required for SUBCATEGORY, forbidden for ROOT. `null` clears it (PATCH).',
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
