import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { PaginatedProductsResponseDto } from './dto/paginated-products-response.dto.js';
import { RelatedProductsQueryDto } from './dto/related-products-query.dto.js';
import { RelatedProductsResponseDto } from './dto/related-products-response.dto.js';
import { ProductDetailDto } from './dto/product-detail.dto.js';
import { ParseIdOrSlugPipe } from './pipes/parse-id-or-slug.pipe.js';
import type { ProductRef } from './pipes/parse-id-or-slug.pipe.js';

@ApiTags('catalog')
@Controller('products')
export class ProductsController {
  constructor(private readonly catalogService: CatalogService) {}

  /**
   * Story 2.2 (FR-6): public, paginated, searchable, filterable Product
   * list. `franchise`/`productType`/`rarity`/`categoryId` combine with AND
   * semantics; `search` is backed by a Postgres pg_trgm GIN index (AD-10).
   * Always 200 — a no-match filter/search combination returns an empty
   * paginated page, never an error (explicit AC). Malformed query params
   * (e.g. `page=abc`, an out-of-enum `franchise`) are rejected with a
   * stable 400 by the global `ValidationPipe` (NFR-3) before reaching this
   * handler.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List/search/filter products',
    description:
      'Returns a paginated Product list. Supports free-text `search` (name/description, pg_trgm-backed) and combinable `franchise`/`productType`/`rarity`/`categoryId` filters. Never errors on no matches — returns an empty paginated page with 200.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated Products matching the given filters/search.',
    type: PaginatedProductsResponseDto,
  })
  listProducts(
    @Query() query: ListProductsQueryDto,
  ): Promise<PaginatedProductsResponseDto> {
    return this.catalogService.listProducts(query);
  }

  /**
   * Story 2.3 (FR-7) + 21.1 (AD-104): public Product detail by id or slug — full description,
   * every `ProductImage`, live `availableStock` (AD-10: direct-to-Postgres
   * read on every call, no caching layer, so this can never be stale), and
   * the joined `Category`. A syntactically invalid id never reaches
   * Prisma/Postgres — `ParseUUIDPipe` rejects it with a stable 400 before
   * the handler runs (the same "malformed input never 500s" pattern
   * Story 2.2's global `ValidationPipe` already established, NFR-3). A
   * well-formed id that matches no row 404s from `CatalogService`.
   */
  @Get(':idOrSlug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get Product detail',
    description:
      "Returns full detail for a single Product: description, every ProductImage, live availableStock (stock - heldQty, no cache, AD-10), Franchise/ProductType/Rarity and the Product's Category.",
  })
  @ApiParam({
    name: 'idOrSlug',
    description: 'Product UUID or slug',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Product detail.',
    type: ProductDetailDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'No active Product exists with the given id or slug (inactive and unknown are not distinguished).',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'The value is neither a valid UUID nor a valid slug (no errorCode).',
  })
  getProductDetail(
    @Param('idOrSlug', ParseIdOrSlugPipe) ref: ProductRef,
  ): Promise<ProductDetailDto> {
    return this.catalogService.getProductDetail(ref);
  }

  /**
   * Story 11.3 (FR-33, AD-20): related products. Declared after `:id`; the
   * extra `/related` segment means the two routes never collide.
   */
  @Get(':idOrSlug/related')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get related products',
    description:
      'Active products related to the given one (same franchise + macro-category first, then same category), in-stock first. Excludes the product itself.',
  })
  @ApiParam({
    name: 'idOrSlug',
    description: 'Product UUID or slug',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Related products (possibly empty).',
    type: RelatedProductsResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'No active Product exists with the given id or slug (inactive and unknown are not distinguished).',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'The value is neither a valid UUID nor a valid slug (no errorCode), or limit outside 1..10.',
  })
  getRelatedProducts(
    @Param('idOrSlug', ParseIdOrSlugPipe) ref: ProductRef,
    @Query() query: RelatedProductsQueryDto,
  ): Promise<RelatedProductsResponseDto> {
    return this.catalogService.getRelatedProducts(ref, query.limit);
  }
}
