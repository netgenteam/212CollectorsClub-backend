import { Injectable } from '@nestjs/common';
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
import { ProductListItemDto } from './dto/product-list-item.dto.js';

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

    const conditions: Prisma.Sql[] = [];
    if (search) {
      conditions.push(
        Prisma.sql`(name % ${search} OR description % ${search})`,
      );
    }
    if (query.franchise) {
      conditions.push(Prisma.sql`franchise = ${query.franchise}::"Franchise"`);
    }
    if (query.productType) {
      conditions.push(
        Prisma.sql`"productType" = ${query.productType}::"ProductType"`,
      );
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
          SELECT id, name, "priceUsd", stock, "heldQty", franchise, "productType", rarity
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
    const productIds = rows.map((row) => row.id);

    // Primary image = first ProductImage per Product ordered by sortOrder —
    // fetched as one batched query (not N+1) and reduced to a first-wins
    // map in JS, since Prisma has no native "first row per group" query.
    const images = productIds.length
      ? await this.prisma.productImage.findMany({
          where: { productId: { in: productIds } },
          orderBy: { sortOrder: 'asc' },
          select: { productId: true, url: true, altText: true },
        })
      : [];
    const primaryImageByProductId = new Map<
      string,
      { url: string; altText: string | null }
    >();
    for (const image of images) {
      if (!primaryImageByProductId.has(image.productId)) {
        primaryImageByProductId.set(image.productId, {
          url: image.url,
          altText: image.altText,
        });
      }
    }

    const data: ProductListItemDto[] = rows.map((row) => {
      const availableStock = Math.max(row.stock - row.heldQty, 0);
      return {
        id: row.id,
        name: row.name,
        price: Number(row.priceUsd),
        inStock: availableStock > 0,
        availableStock,
        franchise: row.franchise,
        productType: row.productType,
        rarity: row.rarity,
        primaryImage: primaryImageByProductId.get(row.id) ?? null,
      };
    });

    const meta: PaginationMetaDto = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };

    return { data, meta };
  }
}
