import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Story 2.2 (FR-6, NFR-3): query params for `GET /api/v1/products`.
 * Every field is optional and independently combinable (AND) with the
 * others — AD-2's native Franchise/ProductType/Rarity enums are validated
 * straight from the generated Prisma enums so this DTO can never drift
 * from the DB's actual valid values. `class-validator` + the global
 * `ValidationPipe` (see `src/common/global-validation-pipe.ts`) turn any
 * malformed value (e.g. `page=abc`, an out-of-enum `franchise`) into a
 * stable 400 response instead of an unhandled 500 downstream.
 */
export class ListProductsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: DEFAULT_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description: `Items per page (max ${MAX_LIMIT}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @ApiPropertyOptional({
    example: 'Charizard',
    description:
      'Free-text search over Product name/description, backed by a Postgres pg_trgm GIN index (AD-10).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @ApiPropertyOptional({
    enum: Franchise,
    enumName: 'Franchise',
    description: 'Filter by Franchise (AD-2 enum).',
  })
  @IsOptional()
  @IsEnum(Franchise)
  franchise?: Franchise;

  @ApiPropertyOptional({
    enum: ProductType,
    enumName: 'ProductType',
    description: 'Filter by Product Type (AD-2 enum).',
  })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({
    enum: Rarity,
    enumName: 'Rarity',
    description: 'Filter by Rarity (AD-2 enum).',
  })
  @IsOptional()
  @IsEnum(Rarity)
  rarity?: Rarity;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter by Category id.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
