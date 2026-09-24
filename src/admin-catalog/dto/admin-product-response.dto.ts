import { ApiProperty } from '@nestjs/swagger';
import {
  Franchise,
  ProductType,
  Rarity,
} from '../../generated/prisma/enums.js';

export class AdminProductImageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: '/uploads/public/products/3f9e4b8a-...-c1a2.jpg',
    description:
      'Server-relative, publicly-fetchable URL (AD-12) — prefix with the API host to load the real file.',
  })
  url: string;

  @ApiProperty({ nullable: true, example: null })
  altText: string | null;

  @ApiProperty({ example: 0 })
  sortOrder: number;
}

export class AdminProductCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Cartas Sueltas' })
  name: string;

  @ApiProperty({ example: 'cartas-sueltas' })
  slug: string;
}

/**
 * Story 8.2. Response shape for every `admin/products` route. Deliberately
 * its own DTO, not a reuse of the public `ProductDetailDto` (Story 2.3) —
 * this one exposes `isActive`/`heldQty`/raw `stock` (never shown to public
 * callers) and every image (not just the primary one), matching the same
 * "admin sees the full row, public sees a curated projection" split
 * `AdminCategoriesService` already established relative to
 * `CatalogService.listCategories`.
 */
export class AdminProductResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Blastoise VMAX' })
  name: string;

  @ApiProperty({ example: 'blastoise-vmax' })
  slug: string;

  @ApiProperty({ example: 'Carta individual Blastoise VMAX.' })
  description: string;

  @ApiProperty({ enum: Franchise })
  franchise: Franchise;

  @ApiProperty({ enum: ProductType })
  productType: ProductType;

  @ApiProperty({ enum: Rarity })
  rarity: Rarity;

  @ApiProperty({ example: 79.99, description: 'Product.priceUsd.' })
  priceUsd: number;

  @ApiProperty({ example: 25, description: 'Raw Product.stock (not clamped).' })
  stock: number;

  @ApiProperty({
    example: 0,
    description: 'Currently held by in-flight Pago Móvil checkouts (AD-6).',
  })
  heldQty: number;

  @ApiProperty({
    example: true,
    description:
      'false = deactivated: hidden from GET /api/v1/products and /products/:id (public), still visible/editable here.',
  })
  isActive: boolean;

  @ApiProperty({ type: AdminProductCategoryDto })
  category: AdminProductCategoryDto;

  @ApiProperty({ type: AdminProductImageDto, isArray: true })
  images: AdminProductImageDto[];

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
