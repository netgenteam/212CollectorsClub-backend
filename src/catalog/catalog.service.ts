import { buildMarketReferences } from './market-references.js';
import type { MarketReferenceDto } from './dto/market-reference.dto.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  Franchise,
  ProductType,
  ProductLanguage,
  Rarity,
} from '../generated/prisma/enums.js';
import { PublicCategoryResponseDto } from './dto/category-response.dto.js';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import {
  PaginatedProductsResponseDto,
  PaginationMetaDto,
} from './dto/paginated-products-response.dto.js';
import { MACRO_CATEGORY_TYPES, type MacroCategory } from './macro-category.js';
import { LANGUAGE_NAMES, LANGUAGE_ORDER } from './language-names.js';
import type { CatalogFacetsResponseDto } from './dto/catalog-facets.dto.js';
import { RelatedProductsResponseDto } from './dto/related-products-response.dto.js';
import type { GradingCompany } from './grading-company.js';
import {
  ProductListItemDto,
  ProductPrimaryImageDto,
} from './dto/product-list-item.dto.js';
import { ProductDetailDto } from './dto/product-detail.dto.js';
import { ProductTagDto } from './dto/product-tag.dto.js';

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
  editionLanguage: ProductLanguage;
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
   * Story 2.1 (FR-5) / Story 13.3 (FR-47; AD-35): public flat list of active
   * Categories whose whole ancestor chain is active, ordered by
   * `sortOrder, name, id`. Filters are applied in SQL with parameterized,
   * DTO-validated values. The CTE walks top-down from active roots with
   * `UNION` (dedup), so a corrupted parent cycle terminates.
   */
  async listCategories(
    query: ListCategoriesQueryDto = {},
  ): Promise<PublicCategoryResponseDto[]> {
    const conditions: Prisma.Sql[] = [];
    if (query.type) {
      conditions.push(Prisma.sql`c."type" = ${query.type}::"CategoryType"`);
    }
    if (query.dimension) {
      conditions.push(
        Prisma.sql`c."dimension" = ${query.dimension}::"CategoryDimension"`,
      );
    }
    if (query.parentId) {
      conditions.push(Prisma.sql`c."parentId" = ${query.parentId}::uuid`);
    }
    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    return this.prisma.$queryRaw<PublicCategoryResponseDto[]>`
      WITH RECURSIVE active_tree(id) AS (
        SELECT id FROM "Categories" WHERE "parentId" IS NULL AND "isActive"
        UNION
        SELECT ch.id FROM "Categories" ch
        JOIN active_tree t ON ch."parentId" = t.id
        WHERE ch."isActive"
      )
      SELECT c.id, c.name, c.slug, c."type", c."dimension", c."parentId",
             c."isActive", c."sortOrder"
      FROM "Categories" c
      JOIN active_tree t ON t.id = c.id
      ${where}
      ORDER BY c."sortOrder" ASC, c.name ASC, c.id ASC`;
  }

  /**
   * Story 13.7 (FR-52, AD-37): filter facets. Exactly two aggregated
   * statements (categories, then languages/totals), independent of the number
   * of categories. The macro filter lives in the JOIN condition so categories
   * with 0 matching products are kept. No cache (AD-10).
   */
  async getFacets(
    macroCategory?: MacroCategory,
  ): Promise<CatalogFacetsResponseDto> {
    const macroJoin = macroCategory
      ? Prisma.sql`AND p."productType" = ANY(${MACRO_CATEGORY_TYPES[macroCategory]}::"ProductType"[])`
      : Prisma.empty;
    const macroWhere = macroCategory
      ? Prisma.sql`AND "productType" = ANY(${MACRO_CATEGORY_TYPES[macroCategory]}::"ProductType"[])`
      : Prisma.empty;

    const [categoryRows, languageRows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          id: string;
          name: string;
          slug: string;
          dimension: string;
          isActive: boolean;
          inStockCount: number;
        }[]
      >`
        WITH RECURSIVE active_tree(id) AS (
          SELECT id FROM "Categories" WHERE "parentId" IS NULL AND "isActive"
          UNION
          SELECT ch.id FROM "Categories" ch
          JOIN active_tree t ON ch."parentId" = t.id
          WHERE ch."isActive"
        )
        SELECT c.id, c.name, c.slug, c."dimension"::text AS dimension,
               c."isActive",
               COUNT(DISTINCT p.id) FILTER (WHERE p.stock - p."heldQty" > 0)::int AS "inStockCount"
        FROM "Categories" c
        JOIN active_tree t ON t.id = c.id
        LEFT JOIN "Product_Categories" pc ON pc."categoryId" = c.id
        LEFT JOIN "Products" p ON p.id = pc."productId" AND p."isActive" = true ${macroJoin}
        WHERE c."dimension" IN ('FRANCHISE'::"CategoryDimension", 'SEALED_FORMAT'::"CategoryDimension")
        GROUP BY c.id, c.name, c.slug, c."dimension", c."isActive", c."sortOrder"
        ORDER BY c."sortOrder" ASC, c.name ASC, c.id ASC`,
      this.prisma.$queryRaw<
        {
          editionLanguage: ProductLanguage;
          total: number;
          inStock: number;
          preorder: number;
        }[]
      >`
        SELECT "editionLanguage",
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE stock - "heldQty" > 0)::int AS "inStock",
               COUNT(*) FILTER (WHERE "isPreorder")::int AS preorder
        FROM "Products"
        WHERE "isActive" = true ${macroWhere}
        GROUP BY "editionLanguage"`,
    ]);

    const toFacet = (r: (typeof categoryRows)[number]) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      inStockCount: r.inStockCount,
      isActive: r.isActive,
    });
    const byLang = new Map(languageRows.map((r) => [r.editionLanguage, r]));
    return {
      franchises: categoryRows
        .filter((r) => r.dimension === 'FRANCHISE')
        .map(toFacet),
      formats: categoryRows
        .filter((r) => r.dimension === 'SEALED_FORMAT')
        .map(toFacet),
      languages: LANGUAGE_ORDER.filter((code) => byLang.has(code)).map(
        (code) => ({
          code,
          name: LANGUAGE_NAMES[code],
          inStockCount: byLang.get(code)!.inStock,
        }),
      ),
      totals: {
        totalProducts: languageRows.reduce((a, r) => a + r.total, 0),
        totalInStock: languageRows.reduce((a, r) => a + r.inStock, 0),
        totalPreorder: languageRows.reduce((a, r) => a + r.preorder, 0),
      },
    };
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
    // Story 13.6 (AD-36): OR inside a parameter via bound arrays, AND between.
    if (query.franchise) {
      conditions.push(
        Prisma.sql`franchise = ANY(${query.franchise}::"Franchise"[])`,
      );
    }
    if (query.language) {
      conditions.push(
        Prisma.sql`"editionLanguage" = ANY(${query.language}::"ProductLanguage"[])`,
      );
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
      // Subtree (any depth, inactive categories included: the product stays
      // visible, A21). `UNION` dedups, so a corrupted cycle terminates. The
      // tag side uses EXISTS so a product is never duplicated by a join.
      const tree = Prisma.sql`WITH RECURSIVE tree(id) AS (
        SELECT id FROM "Categories" WHERE id = ANY(${query.categoryId}::uuid[])
        UNION
        SELECT c.id FROM "Categories" c JOIN tree t ON c."parentId" = t.id
      ) SELECT id FROM tree`;
      conditions.push(
        Prisma.sql`("Products"."categoryId" IN (${tree}) OR EXISTS (SELECT 1 FROM "Product_Categories" pc WHERE pc."productId" = "Products".id AND pc."categoryId" IN (${tree})))`,
      );
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
          SELECT id, name, slug, "isPreorder", "releaseDate", "priceUsd", stock, "heldQty", franchise, "productType", "editionLanguage", rarity
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
   * Story 11.3 (FR-33, AD-20): related products. Base product must exist and
   * be active (else 404, same as detail). One raw statement ranks candidates:
   * in-stock first, then same franchise + same macro-category, then
   * same category, then name/id. `toListItems` adds one batched image query.
   */
  async getRelatedProducts(
    id: string,
    limit: number,
  ): Promise<RelatedProductsResponseDto> {
    const base = await this.prisma.product.findUnique({
      where: { id, isActive: true },
      select: {
        id: true,
        franchise: true,
        productType: true,
        categoryId: true,
      },
    });
    if (!base) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const macroSet: ProductType[] = Object.values(MACRO_CATEGORY_TYPES).find(
      (types) => types.includes(base.productType),
    ) ?? [base.productType];
    const strongMatch = Prisma.sql`(franchise = ${base.franchise}::"Franchise" AND "productType" = ANY(${macroSet}::"ProductType"[]) AND franchise <> 'OTHER'::"Franchise")`;

    const rows = await this.prisma.$queryRaw<ProductSearchRow[]>(
      Prisma.sql`
        SELECT id, name, slug, "isPreorder", "releaseDate", "priceUsd", stock, "heldQty", franchise, "productType", "editionLanguage", rarity
        FROM "Products"
        WHERE "isActive" = true
          AND id <> ${id}::uuid
          AND (${strongMatch} OR "categoryId" = ${base.categoryId}::uuid)
        ORDER BY ((stock - "heldQty") > 0) DESC,
                 CASE WHEN ${strongMatch} THEN 0 ELSE 1 END ASC,
                 name ASC, id ASC
        LIMIT ${limit}
      `,
    );

    return { data: await this.toListItems(rows) };
  }

  /**
   * Story 11.5 (AD-19, AD-22): active products by id as `ProductListItemDto[]`,
   * in the order of `ids` (unknown/inactive ids are omitted). Reuses
   * `toListItems`, so the shape is identical to the catalog list.
   */
  async findListItemsByIds(ids: string[]): Promise<ProductListItemDto[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.$queryRaw<ProductSearchRow[]>(
      Prisma.sql`
        SELECT id, name, slug, "isPreorder", "releaseDate", "priceUsd", stock, "heldQty", franchise, "productType", "editionLanguage", rarity
        FROM "Products"
        WHERE "isActive" = true AND id = ANY(${ids}::uuid[])
      `,
    );
    const position = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    return this.toListItems(rows);
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
        editionLanguage: row.editionLanguage,
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
        marketReferences: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const availableStock = Math.max(product.stock - product.heldQty, 0);
    const categories = await this.listActiveTags(product.id);

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
      editionLanguage: product.editionLanguage,
      rarity: product.rarity,
      category: product.category,
      categories,
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
      marketReferences: buildMarketReferences(
        product,
        product.marketReferences,
      ) as MarketReferenceDto[],
    };
  }

  /**
   * Story 13.5 (AD-36): the product's tags whose Category and every ancestor
   * are active — one statement, same top-down CTE as `listCategories`.
   */
  private async listActiveTags(productId: string): Promise<ProductTagDto[]> {
    return this.prisma.$queryRaw<ProductTagDto[]>`
      WITH RECURSIVE active_tree(id) AS (
        SELECT id FROM "Categories" WHERE "parentId" IS NULL AND "isActive"
        UNION
        SELECT ch.id FROM "Categories" ch
        JOIN active_tree t ON ch."parentId" = t.id
        WHERE ch."isActive"
      )
      SELECT c.id, c.name, c.slug, c."dimension"
      FROM "Product_Categories" pc
      JOIN "Categories" c ON c.id = pc."categoryId"
      JOIN active_tree t ON t.id = c.id
      WHERE pc."productId" = ${productId}::uuid
      ORDER BY c."sortOrder" ASC, c.name ASC, c.id ASC`;
  }
}
