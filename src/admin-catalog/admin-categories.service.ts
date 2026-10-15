import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { CategoryDimension, CategoryType } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminCategoryResponseDto } from './dto/admin-category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { ListAdminCategoriesQueryDto } from './dto/list-admin-categories-query.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  type: true,
  dimension: true,
  parentId: true,
  isActive: true,
  sortOrder: true,
} as const;

type CategoryRow = Prisma.CategoryGetPayload<{
  select: typeof CATEGORY_SELECT;
}>;

/** Story 13.2 (AD-34): max tree depth (ROOT = 1). */
const MAX_DEPTH = 3;
/** Safety cap for the subtree-height CTE (cannot loop on corrupt data). */
const HEIGHT_CAP = 10;

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

function badRequest(errorCode: string, message: string): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, errorCode, message);
}

/** True when a P2003 refers to the `parentId` self-FK (vs `Products.categoryId`). */
function isParentFkViolation(
  err: Prisma.PrismaClientKnownRequestError,
): boolean {
  return `${JSON.stringify(err.meta ?? {})} ${err.message}`.includes(
    'parentId',
  );
}

/** Escapes `\`, `%` and `_` so user input matches literally in `ILIKE ... ESCAPE '\'` (AD-35). */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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

  async create(dto: CreateCategoryDto): Promise<AdminCategoryResponseDto> {
    const type = dto.type ?? CategoryType.ROOT;
    const dimension = dto.dimension ?? null;
    const parentId = dto.parentId ?? null;
    this.assertMergedState(type, dimension, parentId);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (parentId !== null) {
          await this.lockTree(tx);
          await this.assertParentPlacement(tx, null, parentId);
        }
        return tx.category.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            type,
            dimension,
            parentId,
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
          },
          select: CATEGORY_SELECT,
        });
      });
      return (await this.withCounts([row]))[0];
    } catch (err) {
      throw this.translateWriteError(err, dto.slug);
    }
  }

  /** Admin listing (Story 13.2, AD-35): optional literal `search`/`q` plus
   * `type`/`dimension`/`isActive` filters, all ANDed. Search runs as an
   * escaped, parameterised `ILIKE` that only returns ids; rows are then
   * loaded with `findMany`. Unpaginated, as before. */
  async findAll(
    query: ListAdminCategoriesQueryDto = {},
  ): Promise<AdminCategoryResponseDto[]> {
    const where: Prisma.CategoryWhereInput = {};
    if (query.type !== undefined) where.type = query.type;
    if (query.dimension !== undefined) where.dimension = query.dimension;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const term = query.search ?? query.q;
    if (term !== undefined && term !== '') {
      const pattern = `%${escapeLike(term)}%`;
      const found = await this.prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "Categories" WHERE name ILIKE ${pattern} ESCAPE '\\' OR slug ILIKE ${pattern} ESCAPE '\\'`,
      );
      where.id = { in: found.map((r) => r.id) };
    }

    const rows = await this.prisma.category.findMany({
      where,
      select: CATEGORY_SELECT,
      orderBy: { name: 'asc' },
    });
    return this.withCounts(rows);
  }

  async findOne(id: string): Promise<AdminCategoryResponseDto> {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    });
    if (!category) {
      throw categoryNotFoundException(id);
    }
    return (await this.withCounts([category]))[0];
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<AdminCategoryResponseDto> {
    const touchesTree = dto.parentId !== undefined || dto.type !== undefined;
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (touchesTree) {
          await this.lockTree(tx);
        }
        const current = await tx.category.findUnique({
          where: { id },
          select: CATEGORY_SELECT,
        });
        if (!current) {
          throw categoryNotFoundException(id);
        }
        // Merged state (AD-34): DTO value if sent (null included), else the
        // current row. Changing to ROOT without explicitly nulling a
        // present dimension/parentId therefore fails the check below.
        const type = dto.type ?? current.type;
        const dimension =
          dto.dimension !== undefined ? dto.dimension : current.dimension;
        const parentId =
          dto.parentId !== undefined ? dto.parentId : current.parentId;
        this.assertMergedState(type, dimension, parentId);
        if (touchesTree && parentId !== null) {
          await this.assertParentPlacement(tx, id, parentId);
        }

        const data: Prisma.CategoryUncheckedUpdateInput = {
          type,
          dimension,
          parentId,
        };
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.slug !== undefined) data.slug = dto.slug;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
        return tx.category.update({
          where: { id },
          data,
          select: CATEGORY_SELECT,
        });
      });
      return (await this.withCounts([row]))[0];
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw categoryNotFoundException(id);
      }
      throw this.translateWriteError(err, dto.slug ?? '');
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.category.delete({ where: { id } });
    } catch (err) {
      if (isPrismaKnownError(err, 'P2025')) {
        throw categoryNotFoundException(id);
      }
      // P2003 = FK violation, raised by Postgres (RESTRICT) — no pre-check,
      // so no TOCTOU. The `parentId` self-FK means children; anything else
      // (Products.categoryId) means products in use.
      if (isPrismaKnownError(err, 'P2003')) {
        if (isParentFkViolation(err)) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            'CATEGORY_HAS_CHILDREN',
            `Category ${id} still has child Categories — delete or move them before deleting this Category.`,
          );
        }
        throw new ApiException(
          HttpStatus.CONFLICT,
          'CATEGORY_IN_USE',
          `Category ${id} is still referenced by one or more Products — reassign or remove those Products before deleting this Category.`,
        );
      }
      throw err;
    }
  }

  /** ROOT => no dimension, no parent; SUBCATEGORY => dimension required. */
  private assertMergedState(
    type: CategoryType,
    dimension: CategoryDimension | null,
    parentId: string | null,
  ): void {
    if (type === CategoryType.ROOT) {
      if (dimension !== null) {
        throw badRequest(
          'CATEGORY_DIMENSION_INVALID',
          'A ROOT Category cannot have a dimension (send dimension: null when changing a SUBCATEGORY to ROOT).',
        );
      }
      if (parentId !== null) {
        throw badRequest(
          'CATEGORY_PARENT_INVALID',
          'A ROOT Category cannot have a parent (send parentId: null when changing a SUBCATEGORY to ROOT).',
        );
      }
    } else if (dimension === null) {
      throw badRequest(
        'CATEGORY_DIMENSION_INVALID',
        'A SUBCATEGORY requires a dimension.',
      );
    }
  }

  /** Serialises every tree-shaped write (AD-34); released at commit/rollback. */
  private async lockTree(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('category-tree'))`;
  }

  /** Must run inside a tx holding the tree lock. `nodeId` is null on create. */
  private async assertParentPlacement(
    tx: Prisma.TransactionClient,
    nodeId: string | null,
    parentId: string,
  ): Promise<void> {
    if (nodeId !== null && parentId === nodeId) {
      throw badRequest(
        'CATEGORY_CYCLE',
        'A Category cannot be its own parent.',
      );
    }
    // `UNION` (not `UNION ALL`) dedupes rows, so the walk terminates even on corrupt data.
    const ancestors = await tx.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE anc(id, "parentId") AS (
        SELECT id, "parentId" FROM "Categories" WHERE id = ${parentId}::uuid
        UNION
        SELECT c.id, c."parentId" FROM "Categories" c JOIN anc a ON c.id = a."parentId"
      ) SELECT id FROM anc`;
    if (ancestors.length === 0) {
      throw badRequest(
        'CATEGORY_PARENT_INVALID',
        `Parent Category ${parentId} does not exist.`,
      );
    }
    if (nodeId !== null && ancestors.some((a) => a.id === nodeId)) {
      throw badRequest(
        'CATEGORY_CYCLE',
        'Moving the Category under one of its own descendants would create a cycle.',
      );
    }
    let height = 0;
    if (nodeId !== null) {
      const rows = await tx.$queryRaw<{ height: number | null }[]>`
        WITH RECURSIVE sub(id, depth) AS (
          SELECT id, 0 FROM "Categories" WHERE id = ${nodeId}::uuid
          UNION
          SELECT c.id, s.depth + 1 FROM "Categories" c JOIN sub s ON c."parentId" = s.id
          WHERE s.depth < ${HEIGHT_CAP}
        ) SELECT MAX(depth)::int AS height FROM sub`;
      height = rows[0]?.height ?? 0;
    }
    // depth(node) = ancestors(parent, incl. parent) + 1; deepest = + subtree height.
    if (ancestors.length + 1 + height > MAX_DEPTH) {
      throw badRequest(
        'CATEGORY_DEPTH_EXCEEDED',
        `The Category tree cannot be deeper than ${MAX_DEPTH} levels.`,
      );
    }
  }

  private translateWriteError(err: unknown, slug: string): unknown {
    if (isPrismaKnownError(err, 'P2002')) {
      return categorySlugTakenException(slug);
    }
    // Parent deleted between our check and the insert/update (RESTRICT FK).
    if (isPrismaKnownError(err, 'P2003') && isParentFkViolation(err)) {
      return badRequest(
        'CATEGORY_PARENT_INVALID',
        'The parent Category no longer exists.',
      );
    }
    return err;
  }

  /** One aggregated query for all ids (no N+1): DISTINCT Products whose main
   * `categoryId` is the Category OR that carry it as a tag (Story 13.5). */
  private async withCounts(
    rows: CategoryRow[],
  ): Promise<AdminCategoryResponseDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const counts = await this.prisma.$queryRaw<{ id: string; n: number }[]>`
      SELECT u.cid::text AS id, COUNT(DISTINCT u.pid)::int AS n
      FROM (
        SELECT "categoryId" AS cid, id AS pid FROM "Products"
        WHERE "categoryId" = ANY(${ids}::uuid[])
        UNION ALL
        SELECT "categoryId" AS cid, "productId" AS pid FROM "Product_Categories"
        WHERE "categoryId" = ANY(${ids}::uuid[])
      ) u GROUP BY u.cid`;
    const byId = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((r) => ({
      ...r,
      _count: { products: byId.get(r.id) ?? 0 },
    }));
  }
}
