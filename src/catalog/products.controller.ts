import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { PaginatedProductsResponseDto } from './dto/paginated-products-response.dto.js';

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
}
