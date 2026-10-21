import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminTcgService } from './admin-tcg.service.js';

const card = (id: string, price: string | null) => ({
  id,
  externalId: `x-${id}`,
  name: `Card ${id}`,
  franchise: 'POKEMON',
  setId: 's1',
  setName: 'Set One',
  cardNumber: '1/10',
  rarity: 'Rare',
  editionLanguage: 'EN',
  imageSmall: null,
  imageLarge: null,
  marketPriceUsd: price,
});

/** Story 15.5 (FR-68, AD-56). Full-stack coverage: test/admin-tcg-master-cards.e2e-spec.ts. */
describe('AdminTcgService', () => {
  let service: AdminTcgService;
  let prisma: {
    masterCard: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    product: { groupBy: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    prisma = {
      masterCard: { count: vi.fn(), findMany: vi.fn() },
      product: { groupBy: vi.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTcgService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AdminTcgService);
  });

  it('builds one AND clause per normalized token plus franchise and set', async () => {
    prisma.masterCard.count.mockResolvedValue(0);
    prisma.masterCard.findMany.mockResolvedValue([]);
    await service.searchMasterCards({
      q: 'Pikáchu  199/165',
      franchise: 'POKEMON',
      set: 'sv3',
      page: 1,
      limit: 20,
    });
    const arg = prisma.masterCard.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(arg.where.franchise).toBe('POKEMON');
    expect(arg.where.AND).toEqual([
      { searchText: { contains: 'pikachu' } },
      { searchText: { contains: '199' } },
      { searchText: { contains: '165' } },
      {
        OR: [
          { setId: 'sv3' },
          { setName: { contains: 'sv3', mode: 'insensitive' } },
        ],
      },
    ]);
    expect(arg.orderBy).toEqual([
      { marketPriceUsd: { sort: 'desc', nulls: 'last' } },
      { name: 'asc' },
      { id: 'asc' },
    ]);
    expect(prisma.product.groupBy).not.toHaveBeenCalled();
  });

  it('maps price/inventory with a single groupBy and builds meta', async () => {
    prisma.masterCard.count.mockResolvedValue(45);
    prisma.masterCard.findMany.mockResolvedValue([
      card('a', '12.50'),
      card('b', null),
    ]);
    prisma.product.groupBy.mockResolvedValue([
      { masterCardId: 'a', _count: { _all: 2 }, _sum: { stock: 7 } },
    ]);
    const res = await service.searchMasterCards({ page: 2, limit: 20 });
    expect(prisma.product.groupBy).toHaveBeenCalledTimes(1);
    expect(res.data[0]).toMatchObject({
      apiPriceUsd: 12.5,
      alreadyInInventory: true,
      currentInventoryStock: 7,
    });
    expect(res.data[1]).toMatchObject({
      apiPriceUsd: null,
      alreadyInInventory: false,
      currentInventoryStock: 0,
    });
    expect(res.meta).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(prisma.masterCard.findMany.mock.calls[0][0]).toMatchObject({
      skip: 20,
      take: 20,
    });
  });
});
