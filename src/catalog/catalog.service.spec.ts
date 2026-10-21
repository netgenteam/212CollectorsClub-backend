import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';

// The DB used for e2e tests is the shared dev Postgres seeded by Story 1.4
// (prisma/seed.ts) — it's never actually empty, so the "no Categories exist"
// AC is exercised here instead, against a mocked PrismaService, rather than
// by deleting shared seed rows out from under other stories/tests. Same
// reasoning applies to `listProducts`'s "no matches" AC below.
describe('CatalogService', () => {
  let service: CatalogService;
  let prisma: {
    category: { findMany: ReturnType<typeof vi.fn> };
    productImage: { findMany: ReturnType<typeof vi.fn> };
    product: { findUnique: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  function buildQuery(
    overrides: Partial<ListProductsQueryDto> = {},
  ): ListProductsQueryDto {
    const query = new ListProductsQueryDto();
    Object.assign(query, overrides);
    return query;
  }

  beforeEach(async () => {
    prisma = {
      category: {
        findMany: vi.fn(),
      },
      productImage: {
        findMany: vi.fn(),
      },
      product: {
        findUnique: vi.fn(),
      },
      $queryRaw: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CatalogService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<CatalogService>(CatalogService);
  });

  describe('listCategories', () => {
    const rows = [
      {
        id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
        name: 'Cartas Sueltas',
        slug: 'cartas-sueltas',
        type: 'ROOT',
        dimension: null,
        parentId: null,
        isActive: true,
        sortOrder: 0,
      },
    ];

    // $queryRaw is a tagged template: (strings, ...values). The only
    // interpolated value is the nested `where` Prisma.Sql fragment.
    function sqlOf(): { head: string; where: string; values: unknown[] } {
      const [strings, frag] = prisma.$queryRaw.mock.calls[0] as [
        string[],
        { text: string; values: unknown[] },
      ];
      return { head: strings.join(''), where: frag.text, values: frag.values };
    }

    it('returns the rows from the raw CTE query (no filters)', async () => {
      prisma.$queryRaw.mockResolvedValue(rows);

      await expect(service.listCategories()).resolves.toEqual(rows);
      const { head, where, values } = sqlOf();
      expect(head).toContain('WITH RECURSIVE');
      expect(head).toContain('UNION');
      expect(head).toContain('ORDER BY c."sortOrder" ASC, c.name ASC');
      expect(where).toBe('');
      expect(values).toEqual([]);
    });

    it('applies filters as parameterized AND conditions', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const parentId = 'dd848f24-aac0-4346-ae25-b672bb0d7e14';

      await service.listCategories({
        type: 'SUBCATEGORY',
        dimension: 'FRANCHISE',
        parentId,
      });
      const { where, values } = sqlOf();
      expect(where).toContain('WHERE c."type" = $1');
      expect(where).toContain('AND c."dimension" = $2');
      expect(where).toContain('AND c."parentId" = $3');
      expect(values).toEqual(['SUBCATEGORY', 'FRANCHISE', parentId]);
    });

    it('returns an empty array (never throws) when no Categories match', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.listCategories()).resolves.toEqual([]);
    });
  });

  describe('listProducts', () => {
    it('maps raw SQL rows + batched primary images into the paginated DTO shape', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
            name: 'Charizard VMAX',
            slug: 'charizard-vmax',
            isPreorder: true,
            releaseDate: new Date('2027-01-15T00:00:00.000Z'),
            priceUsd: '89.99',
            stock: 12,
            heldQty: 0,
            franchise: 'POKEMON',
            productType: 'SINGLE_CARD',
            rarity: 'ULTRA_RARE',
          },
        ])
        .mockResolvedValueOnce([{ count: '1' }]);
      prisma.productImage.findMany.mockResolvedValue([
        {
          id: 'img-1',
          productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
          url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
          altText: 'Charizard VMAX - frente',
          sortOrder: 0,
        },
      ]);

      const result = await service.listProducts(buildQuery());

      expect(result).toEqual({
        data: [
          {
            id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
            name: 'Charizard VMAX',
            slug: 'charizard-vmax',
            isPreorder: true,
            releaseDate: '2027-01-15T00:00:00.000Z',
            price: 89.99,
            inStock: true,
            availableStock: 12,
            franchise: 'POKEMON',
            productType: 'SINGLE_CARD',
            rarity: 'ULTRA_RARE',
            primaryImage: {
              id: 'img-1',
              sortOrder: 0,
              url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
              altText: 'Charizard VMAX - frente',
            },
          },
        ],
        meta: {
          page: 1,
          limit: 20,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
      expect(prisma.productImage.findMany).toHaveBeenCalledWith({
        where: { productId: { in: ['f65915f5-2931-4e50-af95-630b1fd7b950'] } },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          productId: true,
          url: true,
          altText: true,
          sortOrder: true,
        },
      });
    });

    it('derives availableStock/inStock from stock - heldQty, clamped at 0', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'p-held-out',
            name: 'Held Out Product',
            priceUsd: '10.00',
            stock: 5,
            heldQty: 5,
            franchise: 'POKEMON',
            productType: 'BOOSTER_PACK',
            rarity: 'COMMON',
          },
        ])
        .mockResolvedValueOnce([{ count: '1' }]);
      prisma.productImage.findMany.mockResolvedValue([]);

      const result = await service.listProducts(buildQuery());

      expect(result.data[0].availableStock).toBe(0);
      expect(result.data[0].inStock).toBe(false);
    });

    it('returns primaryImage: null for a Product with no ProductImages', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'p-no-image',
            name: 'No Image Product',
            priceUsd: '1.00',
            stock: 1,
            heldQty: 0,
            franchise: 'POKEMON',
            productType: 'BOOSTER_PACK',
            rarity: 'COMMON',
          },
        ])
        .mockResolvedValueOnce([{ count: '1' }]);
      prisma.productImage.findMany.mockResolvedValue([]);

      const result = await service.listProducts(buildQuery());

      expect(result.data[0].primaryImage).toBeNull();
    });

    it('returns a valid empty paginated page (never throws) when nothing matches, and skips the image lookup', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }]);

      const result = await service.listProducts(
        buildQuery({
          franchise: 'POKEMON' as never,
          rarity: 'SECRET_RARE' as never,
        }),
      );

      expect(result).toEqual({
        data: [],
        meta: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
      expect(prisma.productImage.findMany).not.toHaveBeenCalled();
    });

    it('computes offset/meta from page and limit', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '45' }]);

      const result = await service.listProducts(
        buildQuery({ page: 3, limit: 10 }),
      );

      expect(result.meta).toEqual({
        page: 3,
        limit: 10,
        total: 45,
        totalPages: 5,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });
  });

  describe('listProducts filters (Story 11.2)', () => {
    function sqlOf(call: number): { sql: string; values: unknown[] } {
      const arg = prisma.$queryRaw.mock.calls[call][0] as {
        sql: string;
        values: unknown[];
      };
      return { sql: arg.sql, values: arg.values };
    }

    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }]);
      prisma.productImage.findMany.mockResolvedValue([]);
    });

    it('expands macroCategory SEALED into an ANY(...::ProductType[]) condition', async () => {
      await service.listProducts(buildQuery({ macroCategory: 'SEALED' }));
      const { sql, values } = sqlOf(0);
      expect(sql).toContain('"productType" = ANY(');
      expect(values).toContainEqual([
        'BOOSTER_PACK',
        'BOOSTER_BOX',
        'STARTER_DECK',
        'COLLECTOR_TIN',
        'ACCESSORY',
      ]);
    });

    it('maps SINGLES to SINGLE_CARD only', async () => {
      await service.listProducts(buildQuery({ macroCategory: 'SINGLES' }));
      expect(sqlOf(0).values).toContainEqual(['SINGLE_CARD']);
    });

    it('intersects productType[] with the macroCategory set', async () => {
      await service.listProducts(
        buildQuery({
          macroCategory: 'SEALED',
          productType: ['BOOSTER_BOX', 'SINGLE_CARD'] as never,
        }),
      );
      expect(sqlOf(0).values).toContainEqual(['BOOSTER_BOX']);
    });

    it('uses a constant FALSE when the intersection is empty', async () => {
      await service.listProducts(
        buildQuery({
          macroCategory: 'SEALED',
          productType: ['SINGLE_CARD'] as never,
        }),
      );
      expect(sqlOf(0).sql).toContain('FALSE');
      expect(sqlOf(1).sql).toContain('FALSE');
    });

    it('adds preorder and in-stock conditions, shared by list and count', async () => {
      await service.listProducts(
        buildQuery({ onlyPreorder: true, onlyInStock: true }),
      );
      for (const call of [0, 1]) {
        expect(sqlOf(call).sql).toContain('"isPreorder" = true');
        expect(sqlOf(call).sql).toContain('(stock - "heldQty") > 0');
      }
    });

    it('selects "editionLanguage" in the list SQL and adds no language filter (Story 13.4)', async () => {
      await service.listProducts(buildQuery({}));
      expect(sqlOf(0).sql).toContain('"editionLanguage"');
      expect(sqlOf(0).sql).not.toContain('"editionLanguage" =');
    });

    it('adds no condition when the booleans are false', async () => {
      await service.listProducts(
        buildQuery({ onlyPreorder: false, onlyInStock: false }),
      );
      expect(sqlOf(0).sql).not.toContain('"isPreorder" = true');
      expect(sqlOf(0).sql).not.toContain('"heldQty") > 0');
    });
  });

  describe('getProductDetail', () => {
    function buildProduct(overrides: Record<string, unknown> = {}) {
      return {
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        name: 'Charizard VMAX',
        slug: 'charizard-vmax',
        description:
          'Carta individual Charizard VMAX, ilustración a página completa.',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'ULTRA_RARE',
        priceUsd: '89.99',
        stock: 12,
        heldQty: 0,
        isPreorder: false,
        releaseDate: null,
        gradingCompany: null,
        gradeValue: null,
        certNumber: null,
        category: {
          id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
          name: 'Cartas Sueltas',
          slug: 'cartas-sueltas',
        },
        images: [
          {
            id: '2eda5451-a7e4-4455-a6e3-98a13eaba941',
            url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
            altText: 'Charizard VMAX - frente',
            sortOrder: 0,
          },
          {
            id: '3eda5451-a7e4-4455-a6e3-98a13eaba942',
            url: 'https://picsum.photos/seed/charizard-vmax-2/600/800',
            altText: 'Charizard VMAX - reverso',
            sortOrder: 1,
          },
        ],
        marketReferences: [],
        ...overrides,
      };
    }

    it('returns full detail, including every ProductImage and the joined Category', async () => {
      const product = buildProduct();
      prisma.product.findUnique.mockResolvedValue(product);

      const result = await service.getProductDetail(product.id);

      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: product.id, isActive: true },
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
      expect(result).toEqual({
        id: product.id,
        name: 'Charizard VMAX',
        slug: 'charizard-vmax',
        description:
          'Carta individual Charizard VMAX, ilustración a página completa.',
        price: 89.99,
        inStock: true,
        availableStock: 12,
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'ULTRA_RARE',
        category: product.category,
        images: product.images,
        isPreorder: false,
        releaseDate: null,
        grading: null,
        marketReferences: [],
      });
    });

    it('lists stored references then a calculated PSA_CERT link (Story 11.4)', async () => {
      const product = buildProduct({
        gradingCompany: 'PSA',
        gradeValue: '10',
        certNumber: '82451937',
        marketReferences: [
          {
            provider: 'CARDMARKET',
            label: 'CM',
            url: 'https://cm.test/x',
            suggestedPriceEur: '79.90',
          },
        ],
      });
      prisma.product.findUnique.mockResolvedValue(product);

      const result = await service.getProductDetail(product.id);

      expect(result.marketReferences).toEqual([
        {
          provider: 'CARDMARKET',
          label: 'CM',
          url: 'https://cm.test/x',
          suggestedPriceEur: 79.9,
        },
        {
          provider: 'PSA_CERT',
          label: 'PSA Cert Verification',
          url: 'https://www.psacard.com/cert/82451937',
        },
      ]);
    });

    it('nests flat grading columns into grading {company, grade, certNumber}, and serializes isPreorder/releaseDate', async () => {
      const product = buildProduct({
        isPreorder: true,
        releaseDate: new Date('2027-01-15T00:00:00.000Z'),
        gradingCompany: 'PSA',
        gradeValue: '10',
        certNumber: '82451937',
      });
      prisma.product.findUnique.mockResolvedValue(product);

      const result = await service.getProductDetail(product.id);

      expect(result.isPreorder).toBe(true);
      expect(result.releaseDate).toBe('2027-01-15T00:00:00.000Z');
      expect(result.grading).toEqual({
        company: 'PSA',
        grade: '10',
        certNumber: '82451937',
      });
    });

    it('throws NotFoundException (never returns null/undefined) when no Product matches the id', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.getProductDetail('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('derives availableStock/inStock from stock - heldQty, clamped at 0', async () => {
      prisma.product.findUnique.mockResolvedValue(
        buildProduct({ stock: 5, heldQty: 5 }),
      );

      const result = await service.getProductDetail(
        'f65915f5-2931-4e50-af95-630b1fd7b950',
      );

      expect(result.availableStock).toBe(0);
      expect(result.inStock).toBe(false);
    });
  });

  describe('getRelatedProducts', () => {
    const baseId = '6f0c2b7e-3c1d-4a55-9d0e-1b2c3d4e5f60';

    it('404s when the base product is missing or inactive', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.getRelatedProducts(baseId, 4)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.product.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: baseId, isActive: true } }),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns { data: [] } without an image query when nothing matches', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: baseId,
        franchise: 'POKEMON',
        productType: 'BOOSTER_BOX',
        categoryId: baseId,
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.getRelatedProducts(baseId, 4)).resolves.toEqual({
        data: [],
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.productImage.findMany).not.toHaveBeenCalled();
    });

    it('binds the macro set of the base type and the limit as parameters', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: baseId,
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        categoryId: baseId,
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await service.getRelatedProducts(baseId, 7);

      const sql = prisma.$queryRaw.mock.calls[0][0] as {
        values: unknown[];
      };
      expect(sql.values).toContainEqual(['SINGLE_CARD']);
      expect(sql.values).toContain(7);
      expect(sql.values).toContain('POKEMON');
    });

    it('maps rows through toListItems (one batched image query)', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: baseId,
        franchise: 'POKEMON',
        productType: 'BOOSTER_BOX',
        categoryId: baseId,
      });
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'a',
          name: 'A',
          slug: 'a',
          isPreorder: false,
          releaseDate: null,
          priceUsd: '5.00',
          stock: 3,
          heldQty: 1,
          franchise: 'POKEMON',
          productType: 'BOOSTER_PACK',
          rarity: 'COMMON',
        },
      ]);
      prisma.productImage.findMany.mockResolvedValue([]);

      const res = await service.getRelatedProducts(baseId, 4);

      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: 'a',
        availableStock: 2,
        inStock: true,
      });
      expect(prisma.productImage.findMany).toHaveBeenCalledTimes(1);
    });
  });
});

// Story 13.7 (AC9, AD-37): constant statement count regardless of categories.
describe('CatalogService.getFacets (Story 13.7)', () => {
  const build = async (
    categoryCount: number,
    groupRows: Record<string, unknown>[] = [],
  ) => {
    const rows = Array.from({ length: categoryCount }, (_, i) => ({
      id: `id-${i}`,
      name: `n${i}`,
      slug: `s${i}`,
      dimension: i % 2 ? 'FRANCHISE' : 'SEALED_FORMAT',
      isActive: true,
      inStockCount: i,
    }));
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([
        { editionLanguage: 'JP', total: 2, inStock: 1, preorder: 1 },
        { editionLanguage: 'ES', total: 1, inStock: 1, preorder: 0 },
      ])
      .mockResolvedValueOnce(groupRows);
    const module = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    const result = await module.get(CatalogService).getFacets();
    return { queryRaw, result };
  };

  it('issues exactly 3 statements for 5 and for 50 categories', async () => {
    const a = await build(5);
    const b = await build(50);
    expect(a.queryRaw).toHaveBeenCalledTimes(3);
    expect(b.queryRaw).toHaveBeenCalledTimes(3);
    expect(b.result.franchises.length + b.result.formats.length).toBe(50);
  });

  it('orders languages ES before JP, sums totals, omits absent codes', async () => {
    const { result } = await build(1);
    expect(result.languages).toEqual([
      { code: 'ES', name: 'Español', inStockCount: 1 },
      { code: 'JP', name: 'Japonés', inStockCount: 1 },
    ]);
    expect(result.totals).toEqual({
      totalProducts: 3,
      totalInStock: 2,
      totalPreorder: 1,
    });
  });
});

// Story 14.2 (AC1/2, AD-43): flat rows -> categoryGroups, order preserved.
describe('CatalogService.getFacets categoryGroups (Story 14.2)', () => {
  const row = (
    id: string,
    parentId: string | null,
    sortOrder: number,
    inStockCount: number,
  ) => ({
    id,
    name: id,
    slug: id,
    sortOrder,
    parentId,
    inStockCount,
  });

  const run = async (groupRows: Record<string, unknown>[]) => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(groupRows);
    const module = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    return module.get(CatalogService).getFacets();
  };

  it('returns [] when there are no groups', async () => {
    expect((await run([])).categoryGroups).toEqual([]);
  });

  it('groups children under their root keeping SQL order', async () => {
    const result = await run([
      row('r1', null, 0, 5),
      row('r2', null, 1, 0),
      row('c1', 'r1', 0, 3),
      row('c2', 'r1', 1, 0),
      row('c3', 'r2', 0, 0),
    ]);
    expect(result.categoryGroups).toEqual([
      {
        id: 'r1',
        name: 'r1',
        slug: 'r1',
        sortOrder: 0,
        inStockCount: 5,
        children: [
          { id: 'c1', name: 'c1', slug: 'c1', sortOrder: 0, inStockCount: 3 },
          { id: 'c2', name: 'c2', slug: 'c2', sortOrder: 1, inStockCount: 0 },
        ],
      },
      {
        id: 'r2',
        name: 'r2',
        slug: 'r2',
        sortOrder: 1,
        inStockCount: 0,
        children: [
          { id: 'c3', name: 'c3', slug: 'c3', sortOrder: 0, inStockCount: 0 },
        ],
      },
    ]);
  });
});
