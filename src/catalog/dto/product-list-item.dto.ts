import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

// Mirrors CategoryResponseDto's pattern: a class (not an interface) so
// @nestjs/swagger can read @ApiProperty metadata at runtime.
export class ProductPrimaryImageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 0, description: 'Display order among images.' })
  sortOrder: number;

  @ApiProperty({
    example: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
    description: 'Public URL of the primary image.',
  })
  url: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Charizard VMAX - frente',
    description: 'Alt text for the primary image, when set.',
  })
  altText: string | null;
}

/**
 * Story 2.2 (FR-6): one item of `GET /api/v1/products`'s paginated list.
 * `price` comes from `Product.priceUsd`; `inStock`/`availableStock` are
 * derived from `stock - heldQty` (AD-6's stock-hold placeholder already on
 * the Story 1.4 schema) rather than raw `stock`, so the storefront never
 * shows units that are actually held by an in-flight Pago Móvil checkout.
 * `primaryImage` is the first `ProductImage` ordered by `sortOrder`, or
 * `null` for a Product with no images.
 */
export class ProductListItemDto {
  @ApiProperty({
    format: 'uuid',
    example: 'f65915f5-2931-4e50-af95-630b1fd7b950',
  })
  id: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  name: string;

  @ApiProperty({ example: 'charizard-vmax' })
  slug: string;

  @ApiProperty({ example: false })
  isPreorder: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-12-01T00:00:00.000Z',
    description: 'Expected release date (ISO 8601) or null.',
  })
  releaseDate: string | null;

  @ApiProperty({
    example: 89.99,
    description: 'Price in USD (Product.priceUsd).',
  })
  price: number;

  @ApiProperty({
    description:
      'True when availableStock (stock - heldQty) is greater than 0.',
  })
  inStock: boolean;

  @ApiProperty({
    example: 12,
    description: 'Effective available stock (stock - heldQty).',
  })
  availableStock: number;

  @ApiProperty({ enum: Franchise, enumName: 'Franchise' })
  franchise: Franchise;

  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  productType: ProductType;

  @ApiProperty({ enum: Rarity, enumName: 'Rarity' })
  rarity: Rarity;

  @ApiPropertyOptional({
    type: ProductPrimaryImageDto,
    nullable: true,
    description:
      'First ProductImage by sortOrder, or null when the Product has no images.',
  })
  primaryImage: ProductPrimaryImageDto | null;
}
