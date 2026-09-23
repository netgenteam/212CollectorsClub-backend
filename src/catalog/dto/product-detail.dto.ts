import { ApiProperty } from '@nestjs/swagger';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

/**
 * Story 2.3: one entry of `ProductDetailDto.images` — unlike Story 2.2's
 * list endpoint (which only ever exposes the single primary image), the
 * detail endpoint returns every `ProductImage` row for the Product, ordered
 * by `sortOrder`.
 */
export class ProductImageItemDto {
  @ApiProperty({
    format: 'uuid',
    example: '2eda5451-a7e4-4455-a6e3-98a13eaba941',
  })
  id: string;

  @ApiProperty({
    example: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
  })
  url: string;

  @ApiProperty({ nullable: true, example: 'Charizard VMAX - frente' })
  altText: string | null;

  @ApiProperty({
    example: 0,
    description: "Display order among this Product's images.",
  })
  sortOrder: number;
}

/**
 * Story 2.3 (Technical Notes): the joined `Category` a Product belongs to —
 * same fields `CategoryResponseDto` exposes at `/api/v1/categories`, kept as
 * its own nested class here since the detail response embeds it rather than
 * a bare `categoryId`.
 */
export class ProductDetailCategoryDto {
  @ApiProperty({
    format: 'uuid',
    example: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
  })
  id: string;

  @ApiProperty({ example: 'Cartas Sueltas' })
  name: string;

  @ApiProperty({ example: 'cartas-sueltas' })
  slug: string;
}

/**
 * Story 2.3 (FR-7): the response shape of `GET /api/v1/products/:id`. Unlike
 * `ProductListItemDto` (Story 2.2), this carries the full `description`,
 * every `ProductImage` (not just the primary one), and the joined
 * `Category`. `price` comes from `Product.priceUsd`; `availableStock`/
 * `inStock` are derived from `stock - heldQty` (same derivation as the list
 * endpoint, for consistency) computed fresh on every request — no caching
 * layer exists anywhere in this app (AD-10), so this value can never be
 * stale.
 */
export class ProductDetailDto {
  @ApiProperty({
    format: 'uuid',
    example: 'f65915f5-2931-4e50-af95-630b1fd7b950',
  })
  id: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  name: string;

  @ApiProperty({ example: 'charizard-vmax' })
  slug: string;

  @ApiProperty({
    example:
      'Carta individual Charizard VMAX, ilustración a página completa. Pieza destacada para coleccionistas de Pokémon.',
    description: 'Full Product description.',
  })
  description: string;

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
    description:
      'Live effective available stock (stock - heldQty), read directly from Postgres at request time — no cache layer (AD-10).',
  })
  availableStock: number;

  @ApiProperty({ enum: Franchise })
  franchise: Franchise;

  @ApiProperty({ enum: ProductType })
  productType: ProductType;

  @ApiProperty({ enum: Rarity })
  rarity: Rarity;

  @ApiProperty({ type: ProductDetailCategoryDto })
  category: ProductDetailCategoryDto;

  @ApiProperty({
    type: ProductImageItemDto,
    isArray: true,
    description: 'Every ProductImage for this Product, ordered by sortOrder.',
  })
  images: ProductImageItemDto[];
}
