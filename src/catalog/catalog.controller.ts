import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service.js';
import { PublicCategoryResponseDto } from './dto/category-response.dto.js';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto.js';

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
      'Returns active Categories (whole ancestor chain active) for storefront menus, optionally filtered by type, dimension and parentId (AND). Empty array when none match; 400 on invalid filter values.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Categories, ordered by sortOrder then name.',
    type: PublicCategoryResponseDto,
    isArray: true,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid type, dimension or parentId.',
  })
  listCategories(
    @Query() query: ListCategoriesQueryDto,
  ): Promise<PublicCategoryResponseDto[]> {
    return this.catalogService.listCategories(query);
  }
}
