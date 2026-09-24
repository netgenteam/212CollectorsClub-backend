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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { AdminProductsService } from './admin-products.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { AdjustProductStockDto } from './dto/adjust-product-stock.dto.js';
import { AdminProductResponseDto } from './dto/admin-product-response.dto.js';
import { createProductImageMulterOptions } from './product-image-multer.config.js';
import { MAX_PRODUCT_IMAGES_PER_REQUEST } from './product-image-upload-paths.constants.js';

const PRODUCT_IMAGES_API_BODY_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: { type: 'string', format: 'binary' },
      description: `1-${MAX_PRODUCT_IMAGES_PER_REQUEST} image files (jpeg/png/webp, max 10 MiB each).`,
    },
  },
} as const;

/**
 * Story 8.2 (FR-22, NFR-3, NFR-4; AD-2, AD-11, AD-12, AD-14). Admin CRUD
 * over `Product`/`ProductImage`, gated at the class level by
 * `AdminAuthGuard` — same wiring `AdminCategoriesController` (Story 8.1)
 * established, and living in the same `admin-catalog/` module so the
 * already-documented `PassportModule.register({ defaultStrategy: 'admin-
 * jwt' })` requirement (see `admin-catalog.module.ts`) is only paid once.
 *
 * `POST /admin/products` and `POST /admin/products/:id/images` are the two
 * `multipart/form-data` routes here — `FilesInterceptor('images', ...)`
 * parses every file under the repeated `images` field using
 * `createProductImageMulterOptions()` (Story 8.2, mirrors Story 4.2's
 * multer pattern but writes under the PUBLIC `uploads/public/` root,
 * AD-12). `PATCH`/`GET`/`DELETE` stay plain JSON, same as
 * `AdminCategoriesController`.
 */
@ApiTags('admin-catalog')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly adminProductsService: AdminProductsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor(
      'images',
      MAX_PRODUCT_IMAGES_PER_REQUEST,
      createProductImageMulterOptions(),
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'name',
        'slug',
        'description',
        'franchise',
        'productType',
        'rarity',
        'priceUsd',
        'stock',
        'categoryId',
        'images',
      ],
      properties: {
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        franchise: { type: 'string' },
        productType: { type: 'string' },
        rarity: { type: 'string' },
        priceUsd: { type: 'number' },
        stock: { type: 'integer' },
        categoryId: { type: 'string', format: 'uuid' },
        ...PRODUCT_IMAGES_API_BODY_SCHEMA.properties,
      },
    },
  })
  @ApiOperation({
    summary: 'Create a Product (with at least one image)',
    description:
      'Multipart create: Franchise/Product Type/Rarity/price/stock/category plus >=1 image file under the repeated "images" field. Immediately visible via the public GET /api/v1/products (Epic 2) once created (isActive defaults true, no cache to invalidate, AD-10). Negative priceUsd/stock are rejected (400) before anything is persisted.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: AdminProductResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode PRODUCT_IMAGE_REQUIRED (no image sent), CATEGORY_NOT_FOUND (categoryId does not exist), or a plain validation 400 (e.g. negative priceUsd/stock, unsupported image MIME type).',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode PRODUCT_SLUG_TAKEN — the given slug is already in use.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  create(
    @Body() dto: CreateProductDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<AdminProductResponseDto> {
    return this.adminProductsService.create(dto, files ?? []);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List every Product (admin — active and deactivated)',
    description:
      'Unlike the public GET /api/v1/products, this list is never filtered by isActive.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: AdminProductResponseDto,
    isArray: true,
  })
  findAll(): Promise<AdminProductResponseDto[]> {
    return this.adminProductsService.findAll();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get one Product by id (admin, regardless of isActive)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: HttpStatus.OK, type: AdminProductResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminProductResponseDto> {
    return this.adminProductsService.findOne(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a Product (including deactivate/reactivate via isActive)',
    description:
      'Partial update. PATCH { "isActive": false } deactivates the Product (hidden from the public catalog, still fully visible/editable here) without ever touching historical OrderLine snapshots; PATCH { "isActive": true } reactivates it.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: HttpStatus.OK, type: AdminProductResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'errorCode PRODUCT_SLUG_TAKEN.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'errorCode CATEGORY_NOT_FOUND, or a plain validation 400.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<AdminProductResponseDto> {
    return this.adminProductsService.update(id, dto);
  }

  @Patch(':id/stock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Directly set a Product's stock count (inventory correction)",
    description:
      'Sets Product.stock to the given absolute value, independent of any Order — never touches heldQty and never creates/resolves a StockHold or OrderStatusHistory row. Reflected immediately in the public GET /api/v1/products and /products/:id (no cache, AD-10). Negative values are rejected (400), same criterion as Story 8.2.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: HttpStatus.OK, type: AdminProductResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'A negative stock value.',
  })
  adjustStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustProductStockDto,
  ): Promise<AdminProductResponseDto> {
    return this.adminProductsService.adjustStock(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete (or, if referenced by history, deactivate) a Product',
    description:
      'Attempts a real delete first. If the Product still has >=1 historical OrderLine/CartItem/StockHold row referencing it, Postgres itself rejects the delete (FK) and this call automatically falls back to isActive=false instead — never corrupting/deleting those historical rows. The response\'s "hardDeleted" flag tells you which happened.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: '{ id, hardDeleted: boolean }',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string; hardDeleted: boolean }> {
    return this.adminProductsService.remove(id);
  }

  @Post(':id/images')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor(
      'images',
      MAX_PRODUCT_IMAGES_PER_REQUEST,
      createProductImageMulterOptions(),
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: PRODUCT_IMAGES_API_BODY_SCHEMA })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Add one or more additional images to an existing Product',
    description:
      'Stores each file under uploads/public/ (AD-12, the only static-mounted path) and creates a new ProductImage row per file, continuing sortOrder after any images the Product already has. Each uploaded file is immediately reachable at its own public URL.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: AdminProductResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode PRODUCT_IMAGE_REQUIRED, or a plain validation 400 (unsupported MIME type).',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given id.',
  })
  addImages(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<AdminProductResponseDto> {
    return this.adminProductsService.addImages(id, files ?? []);
  }
}
