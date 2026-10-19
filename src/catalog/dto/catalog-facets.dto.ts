import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ProductLanguage } from '../../generated/prisma/enums.js';
import { MacroCategory } from '../macro-category.js';

/** Story 13.7 (FR-52, AD-37). Query of the public `GET /api/v1/catalog/facets`. */
export class CatalogFacetsQueryDto {
  @ApiPropertyOptional({
    enum: MacroCategory,
    enumName: 'MacroCategory',
    description:
      'Restrict every count to SEALED or SINGLES (same definition as GET /products).',
  })
  @IsOptional()
  @IsEnum(MacroCategory)
  macroCategory?: MacroCategory;
}

export class FacetCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Pokémon' })
  name: string;

  @ApiProperty({ example: 'franchise-pokemon' })
  slug: string;

  @ApiProperty({
    example: 12,
    description:
      'Distinct active products tagged directly with this category and with stock - heldQty > 0.',
  })
  inStockCount: number;

  @ApiProperty({ example: true })
  isActive: boolean;
}

export class FacetLanguageDto {
  @ApiProperty({ enum: ProductLanguage, enumName: 'ProductLanguage' })
  code: ProductLanguage;

  @ApiProperty({ example: 'Japonés' })
  name: string;

  @ApiProperty({ example: 4 })
  inStockCount: number;
}

export class FacetTotalsDto {
  @ApiProperty({ example: 120, description: 'Active products.' })
  totalProducts: number;

  @ApiProperty({ example: 80, description: 'Active with stock - heldQty > 0.' })
  totalInStock: number;

  @ApiProperty({ example: 5, description: 'Active with isPreorder = true.' })
  totalPreorder: number;
}

export class CategoryGroupChildDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Booster Box' })
  name: string;

  @ApiProperty({ example: 'booster-box' })
  slug: string;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({
    example: 7,
    description:
      'Distinct active in-stock products in this category or any descendant (same as GET /products?categoryId=<id>&onlyInStock=true).',
  })
  inStockCount: number;
}

export class CategoryGroupDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Sellados' })
  name: string;

  @ApiProperty({ example: 'sellados' })
  slug: string;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({
    example: 12,
    description:
      'Distinct in-stock products in the whole subtree (not the sum of children).',
  })
  inStockCount: number;

  @ApiProperty({ type: () => [CategoryGroupChildDto] })
  children: CategoryGroupChildDto[];
}

export class CatalogFacetsResponseDto {
  @ApiProperty({ type: () => [FacetCategoryDto] })
  franchises: FacetCategoryDto[];

  @ApiProperty({ type: () => [FacetCategoryDto] })
  formats: FacetCategoryDto[];

  @ApiProperty({ type: () => [FacetLanguageDto] })
  languages: FacetLanguageDto[];

  @ApiProperty({ type: () => FacetTotalsDto })
  totals: FacetTotalsDto;

  @ApiProperty({
    type: () => [CategoryGroupDto],
    description:
      'Active ROOT categories with at least one active child, each with its active direct children.',
  })
  categoryGroups: CategoryGroupDto[];
}
