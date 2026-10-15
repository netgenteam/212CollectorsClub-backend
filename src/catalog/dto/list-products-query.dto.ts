import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ProductLanguage,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';
import { MacroCategory } from '../macro-category.js';

export const MAX_PRODUCT_TYPES = 10;
export const MAX_MULTI_VALUES = 20;

// Story 13.6 (AD-36): a single string becomes a one-element array; repeated
// keys already arrive as arrays. Bracket keys (`franchise[]=`) are not
// supported: Express 5's `simple` parser keeps the key as `franchise[]`, which
// `whitelist` drops, so they are ignored (200).
const toArray = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? [value] : value;

// Explicit string->boolean (no implicit conversion: 'false' must stay false).
// Anything else is left untouched so `@IsBoolean` rejects it with a 400.
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

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
    isArray: true,
    maxItems: MAX_MULTI_VALUES,
    description:
      'Filter by one or more Franchises (AD-2 enum); repeat the param for several (max 20, OR). Bracket form `franchise[]=` is not supported and is ignored.',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(MAX_MULTI_VALUES)
  @IsEnum(Franchise, { each: true })
  franchise?: Franchise[];

  @ApiPropertyOptional({
    enum: ProductLanguage,
    enumName: 'ProductLanguage',
    isArray: true,
    maxItems: MAX_MULTI_VALUES,
    description:
      'Filter by edition language (uppercase codes); repeat the param for several (max 20, OR). Bracket form `language[]=` is not supported and is ignored.',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(MAX_MULTI_VALUES)
  @IsEnum(ProductLanguage, { each: true })
  language?: ProductLanguage[];

  @ApiPropertyOptional({
    enum: ProductType,
    enumName: 'ProductType',
    isArray: true,
    maxItems: MAX_PRODUCT_TYPES,
    description:
      'Filter by one or more Product Types (AD-2 enum); repeat the param for several (max 10). Bracket form `productType[]=` is not supported and is ignored.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? [value] : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_TYPES)
  @IsEnum(ProductType, { each: true })
  productType?: ProductType[];

  @ApiPropertyOptional({
    enum: MacroCategory,
    enumName: 'MacroCategory',
    description: 'SEALED (packs, boxes, decks, tins, accessories) or SINGLES.',
  })
  @IsOptional()
  @IsEnum(MacroCategory)
  macroCategory?: MacroCategory;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only products with stock - heldQty > 0.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyInStock?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only preorder products (isPreorder = true).',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyPreorder?: boolean;

  @ApiPropertyOptional({
    enum: Rarity,
    enumName: 'Rarity',
    description: 'Filter by Rarity (AD-2 enum).',
  })
  @IsOptional()
  @IsEnum(Rarity)
  rarity?: Rarity;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    isArray: true,
    maxItems: MAX_MULTI_VALUES,
    description:
      'Filter by one or more Category ids (max 20, OR). Includes descendants at any depth; a product matches by its main category or any of its tags. Bracket form `categoryId[]=` is not supported and is ignored.',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(MAX_MULTI_VALUES)
  @IsUUID('all', { each: true })
  categoryId?: string[];
}
