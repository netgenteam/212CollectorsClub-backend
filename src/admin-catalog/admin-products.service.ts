import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  Product,
  ProductImage,
  Category,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { GradingCompany } from '../catalog/grading-company.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { AdjustProductStockDto } from './dto/adjust-product-stock.dto.js';
import {
  AdminProductResponseDto,
  AdminProductImageDto,
} from './dto/admin-product-response.dto.js';
import {
  buildProductImagePublicUrl,
  PRODUCT_IMAGES_SUBDIR,
  PUBLIC_STATIC_PREFIX,
  UPLOADS_PUBLIC_ROOT,
} from './product-image-upload-paths.constants.js';

type ProductWithRelations = Product & {
  category: Category;
  images: ProductImage[];
};

const PRODUCT_INCLUDE = {
  category: true,
  images: { orderBy: { sortOrder: 'asc' as const } },
} as const;

function isPrismaKnownError(
  err: unknown,
  code: string,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}

function productNotFoundException(id: string): NotFoundException {
  return new NotFoundException(`Product ${id} not found`);
}

function productSlugTakenException(slug: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'PRODUCT_SLUG_TAKEN',
    `Product slug "${slug}" is already in use by another Product.`,
  );
}

function categoryNotFoundForProductException(categoryId: string): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'CATEGORY_NOT_FOUND',
    `Category ${categoryId} does not exist — cannot assign this Product to it.`,
  );
}

function productImageRequiredException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'PRODUCT_IMAGE_REQUIRED',
    'At least one image file is required in the "images" multipart field.',
  );
}

/** Best-effort cleanup of files multer already wrote to disk before a
 * validation/business-rule rejection runs — same "delete the now-orphaned
 * upload, never surface a cleanup failure on top of the real rejection"
 * pattern `ProofOfPaymentService.recordUpload` (Story 4.2) already
 * established. */
async function cleanupUploadedFiles(
  files: readonly Express.Multer.File[],
): Promise<void> {
  await Promise.all(
    files.map((file) => unlink(file.path).catch(() => undefined)),
  );
}

/**
 * Story 8.2 (FR-22, NFR-3, NFR-4; AD-2, AD-11, AD-12). Admin CRUD over
 * `Product`/`ProductImage` — the second Epic 8 service to consume
 * `AdminAuthGuard`, following `AdminCategoriesService`'s exact "translate
 * the known Prisma error code, rethrow anything else" shape.
 *
 * **Deactivate vs. delete — the actual design decision this story asks
 * for**: `Product` participates in THREE foreign keys that carry no
 * explicit `onDelete` in `prisma/schema.prisma` — `OrderLine.productId`,
 * `CartItem.productId` and `StockHold.productId` — which Prisma/Postgres
 * therefore default to `RESTRICT`-equivalent (`NO ACTION`) at the DB level
 * (confirmed by inspection of the schema; only `ContactInquiry.productId`
 * is `SetNull` and only `ProductImage.productId` is `Cascade`). A real
 * `DELETE FROM "Products"` while ANY row in those three tables still
 * references this Product is therefore physically rejected by Postgres
 * itself, before this service has to reason about which of the three it
 * was — exactly the guarantee this story's AC needs ("past Orders still
 * show what was actually purchased", i.e. `OrderLine` must never be
 * touched). `remove()` below reuses `AdminCategoriesService.remove`'s own
 * pattern (Story 8.1): attempt the real delete first (no pre-check
 * `SELECT COUNT(*)`, which would be a TOCTOU race), and translate the
 * resulting `P2003` into an automatic **fallback to deactivation**
 * (`isActive = false`) rather than a bare error — a single `DELETE` call
 * from the Admin's point of view always succeeds at "this Product is gone
 * from the storefront", either by actually removing the row (a Product
 * with zero historical references) or by deactivating it (one with
 * history) — the response body's `hardDeleted` flag tells the caller which
 * happened. `PATCH { isActive: false }` (`update()`) is the other, fully
 * explicit way to reach the same deactivated state (and the only way to
 * reactivate via `isActive: true`) — both paths write the exact same
 * column, so there is only ever one "is this Product hidden" bit to reason
 * about.
 */
@Injectable()
export class AdminProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateProductDto,
    files: readonly Express.Multer.File[],
  ): Promise<AdminProductResponseDto> {
    if (files.length === 0) {
      throw productImageRequiredException();
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            description: dto.description,
            franchise: dto.franchise,
            productType: dto.productType,
            rarity: dto.rarity,
            priceUsd: dto.priceUsd,
            stock: dto.stock,
            categoryId: dto.categoryId,
            isPreorder: dto.isPreorder,
            releaseDate: dto.releaseDate
              ? new Date(dto.releaseDate)
              : undefined,
            gradingCompany: dto.gradingCompany,
            gradeValue: dto.gradeValue,
            certNumber: dto.certNumber,
          },
        });
        await tx.productImage.createMany({
          data: files.map((file, index) => ({
            productId: product.id,
            url: buildProductImagePublicUrl(file.filename),
            altText: null,
            sortOrder: index,
          })),
        });
        return product;
      });

      return this.findOne(created.id);
    } catch (err) {
      // Nothing was persisted (the transaction above rolled back in full)
      // — the uploaded files are now orphaned on disk, so clean them up
      // best-effort before rethrowing a stable response.
      await cleanupUploadedFiles(files);
      if (isPrismaKnownError(err, 'P2002')) {
        throw productSlugTakenException(dto.slug);
      }
      if (isPrismaKnownError(err, 'P2003')) {
        throw categoryNotFoundForProductException(dto.categoryId);
      }
      throw err;
    }
  }

  /** Admin listing — every Product regardless of `isActive` (unlike the
   * public `GET /api/v1/products`, Story 2.2, which Story 8.2 now filters
   * to `isActive: true` only). No pagination/search — out of this story's
   * scope; the public catalog already owns that (Epic 2). */
  async findAll(): Promise<AdminProductResponseDto[]> {
    const products = await this.prisma.product.findMany({
      include: PRODUCT_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return products.map((p) => this.toDto(p));
  }

  async findOne(id: string): Promise<AdminProductResponseDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });
    if (!product) {
      throw productNotFoundException(id);
    }
    return this.toDto(product);
  }

  async update(
    id: string,
    dto: UpdateProductDto,
  ): Promise<AdminProductResponseDto> {
    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.franchise !== undefined) data.franchise = dto.franchise;
    if (dto.productType !== undefined) data.productType = dto.productType;
    if (dto.rarity !== undefined) data.rarity = dto.rarity;
    if (dto.priceUsd !== undefined) data.priceUsd = dto.priceUsd;
    if (dto.stock !== undefined) data.stock = dto.stock;
    if (dto.categoryId !== undefined) data.categoryId = dto.categoryId;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.isPreorder !== undefined) data.isPreorder = dto.isPreorder;
    if (dto.releaseDate !== undefined)
      data.releaseDate =
        dto.releaseDate === null ? null : new Date(dto.releaseDate);
    if (dto.gradeValue !== undefined) data.gradeValue = dto.gradeValue;
    if (dto.certNumber !== undefined) data.certNumber = dto.certNumber;

    // Story 11.1 (AD-18): grade/cert only make sense with a real grading
    // house. Validate against the RESULTING company (body, else stored) and
    // clear them when the company is set to null/RAW.
    const touchesGrading =
      dto.gradingCompany !== undefined ||
      (dto.gradeValue !== undefined && dto.gradeValue !== null) ||
      (dto.certNumber !== undefined && dto.certNumber !== null);
    if (touchesGrading) {
      let company: string | null;
      if (dto.gradingCompany !== undefined) {
        company = dto.gradingCompany;
      } else {
        const stored = await this.prisma.product.findUnique({
          where: { id },
          select: { gradingCompany: true },
        });
        if (!stored) throw productNotFoundException(id);
        company = stored.gradingCompany;
      }
      const graded = company !== null && company !== 'RAW';
      if (!graded) {
        if (
          (dto.gradeValue !== undefined && dto.gradeValue !== null) ||
          (dto.certNumber !== undefined && dto.certNumber !== null)
        ) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            'GRADING_COMPANY_REQUIRED',
            'gradeValue/certNumber require gradingCompany to be PSA, BGS or CGC (not null/RAW).',
          );
        }
        data.gradeValue = null;
        data.certNumber = null;
      }
      if (dto.gradingCompany !== undefined) {
        data.gradingCompany = dto.gradingCompany;
      }
    }

    try {
      await this.prisma.product.update({ where: { id }, data });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw productNotFoundException(id);
      }
      if (isPrismaKnownError(err, 'P2002')) {
        throw productSlugTakenException(dto.slug ?? '');
      }
      if (isPrismaKnownError(err, 'P2003')) {
        throw categoryNotFoundForProductException(dto.categoryId ?? '');
      }
      throw err;
    }
    return this.findOne(id);
  }

  /**
   * Story 8.3 (FR-24, NFR-2, NFR-4; AD-10). `PATCH /admin/products/:id/
   * stock` — sets `Product.stock` directly to the given absolute value,
   * completely independent of any Order: unlike the checkout/hold flow
   * (Epic 4, AD-6), this never touches `Product.heldQty` and never
   * creates/resolves a `StockHold` or `OrderStatusHistory` row. It exists
   * as its own narrow endpoint (rather than requiring admins to go through
   * the general `update()` above, which also technically accepts `stock`)
   * so a physical-inventory-count correction reads as its own intent in
   * the API surface, matching the story's framing.
   *
   * No cache layer sits in front of the public catalog reads (AD-10,
   * already the case since Epic 2) — this write is a plain, synchronous
   * `UPDATE` against the same table `CatalogService.listProducts`/
   * `getProductDetail` read from on every request, so the new value is
   * visible on the very next public read with no invalidation step needed
   * (~0s staleness, per this story's AC2).
   *
   * **Design decision — `stock` set below the current `heldQty`**: not
   * explicit in the AC, so documented here rather than silently picked.
   * `heldQty` counts Pago Móvil checkouts currently sitting in
   * `pending_verification` (Epic 4, AD-6) — a physical inventory count is
   * authoritative and can legitimately land below that number (e.g. an
   * admin finds fewer physical units than the DB believes are even
   * "available"). This method allows the write unconditionally: it does
   * NOT block, warn, or auto-adjust `heldQty` to compensate. Two reasons:
   * (1) the public reads that matter (`listProducts`/`getProductDetail`)
   * already clamp `availableStock = max(stock - heldQty, 0)` to zero, so a
   * `stock < heldQty` state never surfaces a negative number to a buyer —
   * it just means the Product correctly shows as out of stock; (2) the
   * in-flight Pago Móvil Orders that hold that `heldQty` are still
   * pending admin verification (Story 9.2, not yet implemented) — that is
   * the right place to decide whether each specific held Order can still
   * be honored against the corrected physical count, not this blunt
   * stock-setter. Silently "fixing" `heldQty` here would be worse: it
   * would make a stock correction invisibly cancel a buyer's pending
   * reservation with no record of why.
   */
  async adjustStock(
    id: string,
    dto: AdjustProductStockDto,
  ): Promise<AdminProductResponseDto> {
    try {
      await this.prisma.product.update({
        where: { id },
        data: { stock: dto.stock },
      });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw productNotFoundException(id);
      }
      throw err;
    }
    return this.findOne(id);
  }

  /** See this class's own doc comment for the full delete-vs-deactivate
   * writeup. `hardDeleted: true` = the row is actually gone (and its
   * ProductImage files best-effort unlinked from disk); `hardDeleted:
   * false` = Postgres rejected the real delete (P2003, historical
   * OrderLine/CartItem/StockHold references) and this call fell back to
   * `isActive = false` instead — the Product row (and every OrderLine that
   * snapshots it) is untouched. */
  async remove(id: string): Promise<{ id: string; hardDeleted: boolean }> {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true, images: { select: { url: true } } },
    });
    if (!existing) {
      throw productNotFoundException(id);
    }

    try {
      await this.prisma.product.delete({ where: { id } });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw productNotFoundException(id);
      }
      // P2003 = foreign key constraint violation — at least one OrderLine/
      // CartItem/StockHold still references this Product (see class doc
      // comment). Deactivate instead of leaving the caller with a bare
      // error; the Product (and every historical OrderLine snapshot) is
      // left completely untouched by this branch.
      if (isPrismaKnownError(err, 'P2003')) {
        await this.prisma.product.update({
          where: { id },
          data: { isActive: false },
        });
        return { id, hardDeleted: false };
      }
      throw err;
    }

    await this.cleanupImageFiles(existing.images.map((image) => image.url));
    return { id, hardDeleted: true };
  }

  /** Story 8.2 AC4: `POST .../products/:id/images` — appends >=1
   * `ProductImage` row to an existing Product, `sortOrder` continuing after
   * whatever images already exist (never renumbering/overwriting them). */
  async addImages(
    id: string,
    files: readonly Express.Multer.File[],
  ): Promise<AdminProductResponseDto> {
    if (files.length === 0) {
      throw productImageRequiredException();
    }

    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!product) {
      await cleanupUploadedFiles(files);
      throw productNotFoundException(id);
    }

    const maxSortOrder = await this.prisma.productImage.aggregate({
      where: { productId: id },
      _max: { sortOrder: true },
    });
    const startOrder = (maxSortOrder._max.sortOrder ?? -1) + 1;

    await this.prisma.productImage.createMany({
      data: files.map((file, index) => ({
        productId: id,
        url: buildProductImagePublicUrl(file.filename),
        altText: null,
        sortOrder: startOrder + index,
      })),
    });

    return this.findOne(id);
  }

  /** Best-effort disk cleanup after a real (non-fallback) hard delete —
   * only ever unlinks a path this service itself generated (the
   * `PUBLIC_STATIC_PREFIX + PRODUCT_IMAGES_SUBDIR/` prefix check), same
   * defensive posture as never trusting client input for a disk path
   * (Story 4.2's rationale). A failure here is logged-and-swallowed, never
   * surfaced on top of the delete the caller already got confirmed. */
  private async cleanupImageFiles(urls: readonly string[]): Promise<void> {
    const knownPrefix = `${PUBLIC_STATIC_PREFIX}${PRODUCT_IMAGES_SUBDIR}/`;
    await Promise.all(
      urls
        .filter((url) => url.startsWith(knownPrefix))
        .map((url) => {
          const filename = url.slice(knownPrefix.length);
          const absolutePath = join(
            UPLOADS_PUBLIC_ROOT,
            PRODUCT_IMAGES_SUBDIR,
            filename,
          );
          return unlink(absolutePath).catch(() => undefined);
        }),
    );
  }

  private toDto(product: ProductWithRelations): AdminProductResponseDto {
    const images: AdminProductImageDto[] = product.images.map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.altText,
      sortOrder: image.sortOrder,
    }));

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      franchise: product.franchise,
      productType: product.productType,
      rarity: product.rarity,
      priceUsd: Number(product.priceUsd),
      stock: product.stock,
      heldQty: product.heldQty,
      isActive: product.isActive,
      isPreorder: product.isPreorder,
      releaseDate: product.releaseDate?.toISOString() ?? null,
      gradingCompany: product.gradingCompany as GradingCompany | null,
      gradeValue: product.gradeValue,
      certNumber: product.certNumber,
      category: {
        id: product.category.id,
        name: product.category.name,
        slug: product.category.slug,
      },
      images,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }
}
