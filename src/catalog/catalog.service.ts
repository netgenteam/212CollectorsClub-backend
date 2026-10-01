import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  Franchise,
  ProductType,
  Rarity,
} from '../generated/prisma/enums.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import {
  PaginatedProductsResponseDto,
  PaginationMetaDto,
} from './dto/paginated-products-response.dto.js';
import { MACRO_CATEGORY_TYPES } from './macro-category.js';
import type { GradingCompany } from './grading-company.js';
import {
  ProductListItemDto,
  ProductPrimaryImageDto,
} from './dto/product-list-item.dto.js';
import { ProductDetailDto } from './dto/product-detail.dto.js';

// Raw shape of one row from the hand-written SQL in `listProducts` below —
// only the columns that query selects, before mapping to ProductListItemDto.
interface ProductSearchRow {
  id: string;
  name: string;
  priceUsd: unknown;
  stock: number;
  heldQty: number;
  franchise: Franchise;
  productType: ProductType;
  rarity: Rarity;
  slug: string;
  isPreorder: boolean;
  releaseDate: Date | null;
}

interface CountRow {
  count: unknown;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 2.1 (FR-5): returns every Category. The AC says "active"
   * Categories, but the `Category` model (Story 1.4) has no `isActive` /
   * soft-delete field yet, and this story's Technical Notes explicitly rule
   * out schema changes — so today every row is implicitly "active" and this
   * is a straight `findMany`. Add an `isActive` filter here once that field
   * exists on the model (likely Story 8.1, admin CRUD Categories).
   */
  async listCategories(): Promise<CategoryResponseDto[]> {
    return this.prisma.category.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Story 2.2 (FR-6, NFR-1, NFR-3): paginated, searchable, filterable
   * Product list.
   *
   * The WHERE clause is built as raw SQL (not the Prisma query builder) so
   * that `search` can use Postgres's pg_trgm `%` similarity operator —
   * `WHERE name % $1` — which is what actually lets the planner use the
   * `Products_name_idx`/`Products_description_idx` GIN indexes added by
   * this story's migration (AD-10); a `contains`/`LIKE '%...%'` filter
   * would force a full sequential scan regardless of the index. The same
   * raw query also carries the combinable AD-2 enum filters and
   * `categoryId`, so search and filters are a single, consistently-ordered
   * SQL statement rather than two divergent code paths. Every value below
   * is passed as a bound parameter via `Prisma.sql`/`Prisma.join` — never
   * string-concatenated — so this stays injection-safe; enum values are
   * additionally guaranteed valid before they ever reach this method by
   * `ListProductsQueryDto`'s `@IsEnum` validation against these same
   * generated Prisma enums.
   */
  async listProducts(
    query: ListProductsQueryDto,
  ): Promise<PaginatedProductsResponseDto> {
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;
    const search = query.search;

    // Story 8.2: closes the gap Story 2.2's own doc comment left open — a
    // deactivated Product (`isActive = false`, Story 8.2's new field) must
    // never appear in the public list, unconditionally (not just when a
    // filter is supplied) — so this is pushed first and always, unlike
    // every other condition below which is only added when its matching
    // query param is present.
    const conditions: Prisma.Sql[] = [Prisma.sql`"isActive" = true`];
    if (search) {
      conditions.push(
        Prisma.sql`(name % ${search} OR description % ${search})`,
      );
    }
    if (query.franchise) {
      conditions.push(Prisma.sql`franchise = ${query.franchise}::"Franchise"`);
    }
    // AD-19: effective ProductType set = productType[] ∩ macroCategory set.
    // An empty intersection becomes a constant FALSE (200, empty page).
    let typeSet: ProductType[] | undefined = query.productType;
    if (query.macroCategory) {
      const macroTypes = MACRO_CATEGORY_TYPES[query.macroCategory];
      typeSet = typeSet
        ? typeSet.filter((type) => macroTypes.includes(type))
        : macroTypes;
    }
    if (typeSet) {
      conditions.push(
        typeSet.length > 0
          ? Prisma.sql`"productType" = ANY(${typeSet}::"ProductType"[])`
          : Prisma.sql`FALSE`,
      );
    }
    if (query.onlyPreorder === true) {
      conditions.push(Prisma.sql`"isPreorder" = true`);
    }
    if (query.onlyInStock === true) {
      conditions.push(Prisma.sql`(stock - "heldQty") > 0`);
    }
    if (query.rarity) {
      conditions.push(Prisma.sql`rarity = ${query.rarity}::"Rarity"`);
    }
    if (query.categoryId) {
      conditions.push(Prisma.sql`"categoryId" = ${query.categoryId}::uuid`);
    }
    const whereSql =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    // Relevance-ranked when searching (closest trigram match first, tied
    // rows broken alphabetically); otherwise plain alphabetical.
    const orderBySql = search
      ? Prisma.sql`ORDER BY GREATEST(similarity(name, ${search}), similarity(description, ${search})) DESC, name ASC`
      : Prisma.sql`ORDER BY name ASC`;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<ProductSearchRow[]>(
        Prisma.sql`
          SELECT id, name, slug, "isPreorder", "releaseDate", "priceUsd", stock, "heldQty", franchise, "productType", rarity
          FROM "Products"
          ${whereSql}
          ${orderBySql}
          LIMIT ${limit} OFFSET ${offset}
        `,
      ),
      this.prisma.$queryRaw<CountRow[]>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "Products" ${whereSql}`,
      ),
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    const data = await this.toListItems(rows);

    const meta: PaginationMetaDto = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };

    return { data, meta };
  }

  /**
   * Story 11.1 (AD-19): maps raw list rows to `ProductListItemDto`, batching
   * the primary-image lookup into one query (no N+1). Reused by later
   * stories (related, wishlist).
   */
  async toListItems(rows: ProductSearchRow[]): Promise<ProductListItemDto[]> {
    const productIds = rows.map((row) => row.id);

    // Primary image = first ProductImage per Product ordered by sortOrder —
    // one batched query reduced to a first-wins map in JS.
    const images = productIds.length
      ? await this.prisma.productImage.findMany({
          where: { productId: { in: productIds } },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            productId: true,
            url: true,
            altText: true,
            sortOrder: true,
          },
        })
      : [];
    const primaryImageByProductId = new Map<string, ProductPrimaryImageDto>();
    for (const image of images) {
      if (!primaryImageByProductId.has(image.productId)) {
        primaryImageByProductId.set(image.productId, {
          id: image.id,
          url: image.url,
          altText: image.altText,
          sortOrder: image.sortOrder,
        });
      }
    }

    return rows.map((row) => {
      const availableStock = Math.max(row.stock - row.heldQty, 0);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        isPreorder: row.isPreorder,
        releaseDate: row.releaseDate ? row.releaseDate.toISOString() : null,
        price: Number(row.priceUsd),
        inStock: availableStock > 0,
        availableStock,
        franchise: row.franchise,
        productType: row.productType,
        rarity: row.rarity,
        primaryImage: primaryImageByProductId.get(row.id) ?? null,
      };
    });
  }

  /**
   * Story 2.3 (FR-7): full detail for a single Product by id — description,
   * every associated `ProductImage` (not just the primary one, unlike
   * Story 2.2's list), live `availableStock` (`stock - heldQty`, same
   * derivation and no-cache guarantee as `listProducts`, per AD-10: direct
   * Postgres read on every call, no caching layer anywhere in this app),
   * and the joined `Category`.
   *
   * Story 8.2 closes the gap this doc comment used to flag: `isActive`
   * (defaults `true`, Story 8.2's new field) is now filtered here too — a
   * deactivated Product 404s exactly like a genuinely missing id, never
   * distinguished from it (no information leak about a deactivated-but-
   * once-real id). `findUnique` accepts `isActive` alongside `id` in the
   * same `where` (Prisma's extended-whereUnique support — `id` alone is
   * still what makes the query plan a unique lookup) rather than switching
   * to `findFirst`.
   */
  async getProductDetail(id: string): Promise<ProductDetailDto> {
    const product = await this.prisma.product.findUnique({
      where: { id, isActive: true },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        images: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, url: true, altText: true, sortOrder: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const availableStock = Math.max(product.stock - product.heldQty, 0);

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: Number(product.priceUsd),
      inStock: availableStock > 0,
      availableStock,
      franchise: product.franchise,
      productType: product.productType,
      rarity: product.rarity,
      category: product.category,
      images: product.images,
      isPreorder: product.isPreorder,
      releaseDate: product.releaseDate?.toISOString() ?? null,
      grading: product.gradingCompany
        ? {
            company: product.gradingCompany as GradingCompany,
            grade: product.gradeValue,
            certNumber: product.certNumber,
          }
        : null,
    };
  }
}
