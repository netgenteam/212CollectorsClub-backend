import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { PaginatedProductsResponseDto } from './dto/paginated-products-response.dto.js';
import { ProductDetailDto } from './dto/product-detail.dto.js';

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
   * Story 2.3 (FR-7): public Product detail by id — full description,
   * every `ProductImage`, live `availableStock` (AD-10: direct-to-Postgres
   * read on every call, no caching layer, so this can never be stale), and
   * the joined `Category`. A syntactically invalid id never reaches
   * Prisma/Postgres — `ParseUUIDPipe` rejects it with a stable 400 before
   * the handler runs (the same "malformed input never 500s" pattern
   * Story 2.2's global `ValidationPipe` already established, NFR-3). A
   * well-formed id that matches no row 404s from `CatalogService`.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get Product detail',
    description:
      "Returns full detail for a single Product: description, every ProductImage, live availableStock (stock - heldQty, no cache, AD-10), Franchise/ProductType/Rarity and the Product's Category.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id.' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Product detail.',
    type: ProductDetailDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'The given id is not a syntactically valid UUID.',
  })
  getProductDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductDetailDto> {
    return this.catalogService.getProductDetail(id);
  }
}
