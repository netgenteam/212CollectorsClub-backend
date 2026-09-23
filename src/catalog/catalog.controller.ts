import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';

@ApiTags('catalog')
@Controller('categories')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  /**
   * Story 2.1 (FR-5): public, read-only list of Categories for storefront
   * browsing/filtering. Always 200 — an empty catalog returns an empty
   * array, never an error (explicit AC).
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List product categories',
    description:
      'Returns every Category for storefront browsing/filtering. Returns an empty array (never an error) when none exist.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Categories, ordered by name.',
    type: CategoryResponseDto,
    isArray: true,
  })
  listCategories(): Promise<CategoryResponseDto[]> {
    return this.catalogService.listCategories();
  }
}
