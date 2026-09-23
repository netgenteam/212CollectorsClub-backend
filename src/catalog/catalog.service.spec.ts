import { Test, TestingModule } from '@nestjs/testing';
import { CatalogService } from './catalog.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

// The DB used for e2e tests is the shared dev Postgres seeded by Story 1.4
// (prisma/seed.ts) — it's never actually empty, so the "no Categories exist"
// AC is exercised here instead, against a mocked PrismaService, rather than
// by deleting shared seed rows out from under other stories/tests.
describe('CatalogService', () => {
  let service: CatalogService;
  let prisma: { category: { findMany: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    prisma = {
      category: {
        findMany: vi.fn(),
      },
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
});
