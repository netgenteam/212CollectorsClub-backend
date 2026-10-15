import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import {
  CatalogFacetsQueryDto,
  CatalogFacetsResponseDto,
} from './dto/catalog-facets.dto.js';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogFacetsController {
  constructor(private readonly catalogService: CatalogService) {}

  /** Story 13.7 (FR-52, AD-37): public filter facets with live in-stock counts. */
  @Get('facets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Catalog filter facets',
    description:
      'Active franchise/format categories (whole ancestor chain active) and available languages with in-stock counts (active product, stock - heldQty > 0), plus totals. Optionally restricted to a macro-category. Not cached.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: CatalogFacetsResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid macroCategory.',
  })
  getFacets(
    @Query() query: CatalogFacetsQueryDto,
  ): Promise<CatalogFacetsResponseDto> {
    return this.catalogService.getFacets(query.macroCategory);
  }
}
