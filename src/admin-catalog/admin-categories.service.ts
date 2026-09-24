import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CategoryResponseDto } from '../catalog/dto/category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

const CATEGORY_SELECT = { id: true, name: true, slug: true } as const;

function isPrismaKnownError(
  err: unknown,
  code: string,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}

function categoryNotFoundException(id: string): NotFoundException {
  return new NotFoundException(`Category ${id} not found`);
}

/** P2002 = unique constraint violation. `Category.slug` (Story 1.4) is the
 * only unique column this service ever writes to, so any P2002 reaching
 * `create`/`update` below is necessarily a duplicate `slug` — translated
 * into a stable, enumerable `409 CATEGORY_SLUG_TAKEN` instead of letting a
 * raw Postgres unique-violation surface as an unhandled 500 (same
 * "translate the known Prisma error code, rethrow anything else" shape
 * `AdminAuthService.logout`'s P2002 handling already established for this
 * codebase). */
function categorySlugTakenException(slug: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'CATEGORY_SLUG_TAKEN',
    `Category slug "${slug}" is already in use by another Category.`,
  );
}

/**
 * Story 8.1 (FR-23, NFR-3, NFR-4; AD-2, AD-11). Admin CRUD over the
 * `Category` model (Story 1.4) — the first Epic 8/9/10 business route to
 * consume `AdminAuthGuard` (Story 7.1's `/admin/auth/me` was a
 * proof-of-wiring route only, not a real feature).
 *
 * **No caching, no extra plumbing needed for "immediately visible"**: every
 * write below (`create`/`update`/`delete`) is a direct Prisma write against
 * the same `Categories` table `CatalogService.listCategories` (Story 2.1,
 * the public `GET /api/v1/categories`) reads from on every call — AD-10
 * already rules out a caching layer anywhere in this app, so there is
 * nothing to invalidate: the very next public read simply sees the new row.
 *
 * **Delete policy (AD-2)**: `Products.categoryId` carries `ON DELETE
 * RESTRICT` at the database level (Story 1.4's migration) — Postgres
 * itself refuses to delete a `Category` row while any `Product` still
 * references it, before this service ever has to reason about it. `remove`
 * below does not pre-check "is this Category referenced?" with a separate
 * `SELECT COUNT(*)` first (which would be a TOCTOU race — a Product could
 * be (re)assigned to this Category between that check and the delete);
 * instead it attempts the delete directly and translates the resulting
 * `P2003` foreign-key-violation into the stable `409 CATEGORY_IN_USE` this
 * story's AC requires. This is single-statement-atomic by construction —
 * Postgres itself is the guard, not application-level locking.
 */
@Injectable()
export class AdminCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    try {
      return await this.prisma.category.create({
        data: { name: dto.name, slug: dto.slug },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2002')) {
        throw categorySlugTakenException(dto.slug);
      }
      throw err;
    }
  }

  /** Admin listing — same rows/shape as the public `GET /api/v1/categories`
   * (Story 2.1), just behind `AdminAuthGuard` instead of open. Kept as its
   * own query (not a call into `CatalogService`) so this module never
   * depends on `CatalogModule` internals — each stays independently
   * deployable per AD-14. */
  async findAll(): Promise<CategoryResponseDto[]> {
    return this.prisma.category.findMany({
      select: CATEGORY_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string): Promise<CategoryResponseDto> {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    });
    if (!category) {
      throw categoryNotFoundException(id);
    }
    return category;
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const data: Prisma.CategoryUpdateInput = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
    }
    if (dto.slug !== undefined) {
      data.slug = dto.slug;
    }

    try {
      return await this.prisma.category.update({
        where: { id },
        data,
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw categoryNotFoundException(id);
      }
      if (isPrismaKnownError(err, 'P2002')) {
        throw categorySlugTakenException(dto.slug ?? '');
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.category.delete({ where: { id } });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw categoryNotFoundException(id);
      }
      // P2003 = foreign key constraint violation — the `Products_
      // categoryId_fkey ON DELETE RESTRICT` constraint rejected this
      // delete because >=1 Product still references this Category. See
      // this class's own doc comment for why this is a catch, not a
      // pre-check.
      if (isPrismaKnownError(err, 'P2003')) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'CATEGORY_IN_USE',
          `Category ${id} is still referenced by one or more Products — reassign or remove those Products before deleting this Category.`,
        );
      }
      throw err;
    }
  }
}
