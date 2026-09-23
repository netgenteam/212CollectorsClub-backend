import { Test, TestingModule } from '@nestjs/testing';
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
      $queryRaw: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CatalogService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<CatalogService>(CatalogService);
  });

  describe('listCategories', () => {
    it('returns the categories from PrismaService, ordered by name', async () => {
      const categories = [
        {
          id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
          name: 'Cartas Sueltas',
          slug: 'cartas-sueltas',
        },
        {
          id: '09d457d9-a402-4915-aca9-ec9648b9a9a8',
          name: 'Sobres y Cajas',
          slug: 'sobres-y-cajas',
        },
      ];
      prisma.category.findMany.mockResolvedValue(categories);

      await expect(service.listCategories()).resolves.toEqual(categories);
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      });
    });

    it('returns an empty array (never throws) when no Categories exist', async () => {
      prisma.category.findMany.mockResolvedValue([]);

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
          productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
          url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
          altText: 'Charizard VMAX - frente',
        },
      ]);

      const result = await service.listProducts(buildQuery());

      expect(result).toEqual({
        data: [
          {
            id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
            name: 'Charizard VMAX',
            price: 89.99,
            inStock: true,
            availableStock: 12,
            franchise: 'POKEMON',
            productType: 'SINGLE_CARD',
            rarity: 'ULTRA_RARE',
            primaryImage: {
              url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
              altText: 'Charizard VMAX - frente',
            },
          },
        ],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
      expect(prisma.productImage.findMany).toHaveBeenCalledWith({
        where: { productId: { in: ['f65915f5-2931-4e50-af95-630b1fd7b950'] } },
        orderBy: { sortOrder: 'asc' },
        select: { productId: true, url: true, altText: true },
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
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
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
      });
    });
  });
});
