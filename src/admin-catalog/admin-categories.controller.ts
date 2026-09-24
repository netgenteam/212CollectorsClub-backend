import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { CategoryResponseDto } from '../catalog/dto/category-response.dto.js';
import { AdminCategoriesService } from './admin-categories.service.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

/**
 * Story 8.1 (FR-23, NFR-3, NFR-4; AD-2, AD-11, AD-14). Admin CRUD over
 * `Category` — the first Epic 8/9/10 controller to gate a real business
 * route with `AdminAuthGuard` (`src/common/admin-auth.guard.ts`, Story
 * 7.1/7.2). Guarded at the class level: every route on this controller
 * requires a valid Admin JWT, so "no token -> 401 INVALID_ADMIN_TOKEN"
 * applies uniformly to all four verbs with no per-route repetition.
 *
 * Lives in its own `admin-catalog/` module rather than inside the public
 * `catalog/` module — per the Architecture Spine's own module map (§4.2
 * `catalog/` vs §4.8 `admin-catalog/`, both listed as separate directories
 * under AD-14's dependency-direction diagram: `Catalog --> AdminCatalog`).
 * This mirrors Story 7.1's `admin-auth/` module and contrasts with the
 * `orders/` module, where AD-14 explicitly calls out a SINGLE module
 * serving both buyer and admin routes — `Category` has no such rule, and
 * the Architecture Spine's directory listing settles it either way.
 */
@ApiTags('admin-catalog')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(
    private readonly adminCategoriesService: AdminCategoriesService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a Category',
    description:
      'Creates a new Category. Immediately visible via the public GET /api/v1/categories (Story 2.1) — no cache to invalidate (AD-10).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CategoryResponseDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode CATEGORY_SLUG_TAKEN — the given slug is already in use.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT.',
  })
  create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.adminCategoriesService.create(dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List every Category (admin)',
    description:
      'Same rows as the public GET /api/v1/categories, behind AdminAuthGuard.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: CategoryResponseDto,
    isArray: true,
  })
  findAll(): Promise<CategoryResponseDto[]> {
    return this.adminCategoriesService.findAll();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get one Category by id (admin)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category id.' })
  @ApiResponse({ status: HttpStatus.OK, type: CategoryResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Category exists with the given id.',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CategoryResponseDto> {
    return this.adminCategoriesService.findOne(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a Category',
    description:
      'Partial update (name and/or slug). Reflected in subsequent public reads immediately.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category id.' })
  @ApiResponse({ status: HttpStatus.OK, type: CategoryResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Category exists with the given id.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode CATEGORY_SLUG_TAKEN — the given slug is already in use by another Category.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.adminCategoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a Category',
    description:
      'Deletes the Category, UNLESS it is still referenced by >=1 Product (AD-2) — that case is rejected with 409 CATEGORY_IN_USE and never orphans the Products or 500s. Reassign/remove those Products first.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category id.' })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Deleted. No response body.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Category exists with the given id.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode CATEGORY_IN_USE — this Category is still referenced by one or more Products.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.adminCategoriesService.remove(id);
  }
}
