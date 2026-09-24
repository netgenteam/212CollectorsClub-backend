import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
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
} from 'class-validator';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

/**
 * Story 8.2 (FR-22). Body of `PATCH /api/v1/admin/products/:id` — plain
 * JSON (unlike `CreateProductDto`, which is multipart), same "every field
 * optional, a partial update" shape as `UpdateCategoryDto`. Numeric fields
 * still carry `@Type(() => Number)` so a JSON body that happens to send a
 * numeric field as a string (or a form client that reuses this same DTO
 * shape) still coerces correctly — harmless no-op for a real JSON number.
 *
 * `isActive` is this story's actual deactivate/reactivate mechanism (see
 * `AdminProductsService`'s doc comment for the full delete-vs-deactivate
 * policy) — `PATCH { isActive: false }` is how an Admin deactivates a
 * Product with historical Orders against it; `PATCH { isActive: true }`
 * reactivates one.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Blastoise VMAX', maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'blastoise-vmax', maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "blastoise-vmax")',
  })
  slug?: string;

  @ApiPropertyOptional({
    example: 'Carta individual Blastoise VMAX, ilustración a página completa.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: Franchise })
  @IsOptional()
  @IsEnum(Franchise)
  franchise?: Franchise;

  @ApiPropertyOptional({ enum: ProductType })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({ enum: Rarity })
  @IsOptional()
  @IsEnum(Rarity)
  rarity?: Rarity;

  @ApiPropertyOptional({
    example: 79.99,
    minimum: 0,
    description: 'Price in USD. Negative values are rejected (400).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  priceUsd?: number;

  @ApiPropertyOptional({
    example: 25,
    minimum: 0,
    description: 'Stock. Negative values are rejected (400).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      'false deactivates the Product (hidden from public catalog reads, still visible/editable here); true reactivates it.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
