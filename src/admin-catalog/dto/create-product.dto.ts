import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

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

  @ApiProperty({ enum: Franchise })
  @IsEnum(Franchise)
  franchise: Franchise;

  @ApiProperty({ enum: ProductType })
  @IsEnum(ProductType)
  productType: ProductType;

  @ApiProperty({ enum: Rarity })
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
}
