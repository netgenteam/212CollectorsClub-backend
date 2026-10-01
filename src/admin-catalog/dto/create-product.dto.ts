import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MARKET_REFERENCES_MAX,
  MarketReferenceInputDto,
  marketReferencesApiProperty,
  TransformMarketReferences,
} from './market-reference-input.dto.js';

import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';
import {
  CERT_NUMBER_REGEX,
  GradingCompany,
} from '../../catalog/grading-company.js';
import { RequiresGradedCompany } from './requires-graded-company.validator.js';

/**
 * Story 8.2 (FR-22, NFR-3, NFR-4; AD-2). The text fields of
 * `POST /api/v1/admin/products` — a `multipart/form-data` request (the
 * route also accepts >=1 image file under the `images` field, handled by
 * `FilesInterceptor`/`createProductImageMulterOptions`, not by this DTO).
 *
 * Every multipart text field arrives as a raw string, unlike this
 * codebase's JSON-body DTOs (`CreateCategoryDto`, `CheckoutDto`, ...) — so
 * numeric fields here need an explicit `@Type(() => Number)` (same pattern
 * `ListProductsQueryDto` already uses for its own string-typed query
 * params) for the global `ValidationPipe`'s `transform: true` to coerce
 * `"12.99"` -> `12.99` before `@IsNumber`/`@Min` ever run.
 *
 * **The actual AC this DTO enforces**: `@Min(0)` on both `priceUsd` and
 * `stock` is the entire "negative price/stock -> rejected, never persisted"
 * requirement — `class-validator` runs before `AdminProductsService.create`
 * is ever called, so a negative value never reaches Prisma. `slug` reuses
 * `CreateCategoryDto`'s exact URL-safe shape/rationale; DB-level
 * uniqueness (`Product.slug` `@unique`, Story 1.4) is translated by the
 * service into `409 PRODUCT_SLUG_TAKEN` (P2002), mirroring
 * `AdminCategoriesService`.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'Blastoise VMAX', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'blastoise-vmax',
    description:
      'URL-safe, unique slug: lowercase letters, digits and single hyphens between segments.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "blastoise-vmax")',
  })
  slug: string;

  @ApiProperty({
    example: 'Carta individual Blastoise VMAX, ilustración a página completa.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description: string;

  @ApiProperty({ enum: Franchise, enumName: 'Franchise' })
  @IsEnum(Franchise)
  franchise: Franchise;

  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  @IsEnum(ProductType)
  productType: ProductType;

  @ApiProperty({ enum: Rarity, enumName: 'Rarity' })
  @IsEnum(Rarity)
  rarity: Rarity;

  @ApiProperty({
    example: 79.99,
    minimum: 0,
    description: 'Price in USD. Negative values are rejected (400).',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  priceUsd: number;

  @ApiProperty({
    example: 25,
    minimum: 0,
    description: 'Initial stock. Negative values are rejected (400).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock: number;

  @ApiProperty({
    format: 'uuid',
    description: 'Category this Product belongs to.',
  })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({
    description: 'Preorder flag (default false).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isPreorder?: boolean;

  @ApiPropertyOptional({
    example: '2026-12-01T00:00:00.000Z',
    description: 'Expected release date (informational only).',
  })
  @IsOptional()
  @IsDateString()
  releaseDate?: string;

  @ApiPropertyOptional({
    enum: GradingCompany,
    enumName: 'GradingCompany',
    description: 'Grading house (PSA|BGS|CGC|RAW).',
  })
  @IsOptional()
  @IsIn(Object.values(GradingCompany))
  gradingCompany?: GradingCompany;

  @ApiPropertyOptional({ example: '9.5', maxLength: 20 })
  @IsOptional()
  @RequiresGradedCompany()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  gradeValue?: string;

  @ApiPropertyOptional({
    example: '12345678',
    description: 'Alphanumeric certification number, max 50 chars.',
  })
  @IsOptional()
  @RequiresGradedCompany()
  @IsString()
  @Matches(CERT_NUMBER_REGEX, {
    message: 'certNumber must be alphanumeric (1-50 chars)',
  })
  certNumber?: string;

  @marketReferencesApiProperty()
  @IsOptional()
  @TransformMarketReferences()
  @IsArray()
  @ArrayMaxSize(MARKET_REFERENCES_MAX)
  @ValidateNested({ each: true })
  marketReferences?: MarketReferenceInputDto[];
}
