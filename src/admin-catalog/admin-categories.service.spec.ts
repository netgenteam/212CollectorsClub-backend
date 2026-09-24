import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminCategoriesService } from './admin-categories.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

const CATEGORY = {
  id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
  name: 'Cartas Sueltas',
  slug: 'cartas-sueltas',
};

/**
 * Story 8.1. Unit-level coverage of the Prisma-error-translation logic that
 * is the actual point of this service — `AdminCategoriesController`'s own
 * tests are e2e-only (real guard, real DB) so this suite focuses on what a
 * real DB round-trip can't cheaply exercise on demand: the exact P2002/
 * P2003/P2025 branches. See `test/admin-categories.e2e-spec.ts` for the
 * full-stack (guard + real Postgres) coverage of the same rules.
 */
describe('AdminCategoriesService', () => {
  let service: AdminCategoriesService;
  let prisma: {
    category: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    prisma = {
      category: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminCategoriesService>(AdminCategoriesService);
  });

  describe('create', () => {
    it('creates and returns the Category', async () => {
      prisma.category.create.mockResolvedValue(CATEGORY);

      const result = await service.create({
        name: 'Cartas Sueltas',
        slug: 'cartas-sueltas',
      });

      expect(result).toEqual(CATEGORY);
      expect(prisma.category.create).toHaveBeenCalledWith({
        data: { name: 'Cartas Sueltas', slug: 'cartas-sueltas' },
        select: { id: true, name: true, slug: true },
      });
    });

    it('translates a P2002 (duplicate slug) into 409 CATEGORY_SLUG_TAKEN, never a raw 500', async () => {
      prisma.category.create.mockRejectedValue(knownRequestError('P2002'));

      const thrown: unknown = await service
        .create({ name: 'Cartas Sueltas', slug: 'cartas-sueltas' })
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 409,
        response: { errorCode: 'CATEGORY_SLUG_TAKEN' },
      });
    });

    it('rethrows any other error untouched', async () => {
      const dbDown = new Error('connection refused');
      prisma.category.create.mockRejectedValue(dbDown);

      await expect(service.create({ name: 'X', slug: 'x' })).rejects.toBe(
        dbDown,
      );
    });
  });

  describe('findAll', () => {
    it('returns every Category ordered by name', async () => {
      prisma.category.findMany.mockResolvedValue([CATEGORY]);

      await expect(service.findAll()).resolves.toEqual([CATEGORY]);
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findOne', () => {
    it('returns the Category when it exists', async () => {
      prisma.category.findUnique.mockResolvedValue(CATEGORY);

      await expect(service.findOne(CATEGORY.id)).resolves.toEqual(CATEGORY);
    });

    it('throws NotFoundException when no Category matches the id', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('sends only the defined fields to Prisma (partial update)', async () => {
      prisma.category.update.mockResolvedValue({
        ...CATEGORY,
        name: 'New Name',
      });

      await service.update(CATEGORY.id, { name: 'New Name' });

      expect(prisma.category.update).toHaveBeenCalledWith({
        where: { id: CATEGORY.id },
        data: { name: 'New Name' },
        select: { id: true, name: true, slug: true },
      });
    });

    it('throws NotFoundException on P2025 (no such Category)', async () => {
      prisma.category.update.mockRejectedValue(knownRequestError('P2025'));

      await expect(
        service.update('00000000-0000-0000-0000-000000000000', {
          name: 'X',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('translates a P2002 (duplicate slug) into 409 CATEGORY_SLUG_TAKEN', async () => {
      prisma.category.update.mockRejectedValue(knownRequestError('P2002'));

      const thrown: unknown = await service
        .update(CATEGORY.id, { slug: 'ya-existe' })
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 409,
        response: { errorCode: 'CATEGORY_SLUG_TAKEN' },
      });
    });
  });

  describe('remove', () => {
    it('deletes the Category when nothing references it', async () => {
      prisma.category.delete.mockResolvedValue(CATEGORY);

      await expect(service.remove(CATEGORY.id)).resolves.toBeUndefined();
      expect(prisma.category.delete).toHaveBeenCalledWith({
        where: { id: CATEGORY.id },
      });
    });

    it('throws NotFoundException on P2025 (no such Category)', async () => {
      prisma.category.delete.mockRejectedValue(knownRequestError('P2025'));

      await expect(
        service.remove('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('translates a P2003 (FK RESTRICT — referenced by >=1 Product) into 409 CATEGORY_IN_USE, never a raw 500 (AD-2)', async () => {
      prisma.category.delete.mockRejectedValue(knownRequestError('P2003'));

      const thrown: unknown = await service
        .remove(CATEGORY.id)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 409,
        response: { errorCode: 'CATEGORY_IN_USE' },
      });
    });

    it('rethrows any other error untouched', async () => {
      const dbDown = new Error('connection refused');
      prisma.category.delete.mockRejectedValue(dbDown);

      await expect(service.remove(CATEGORY.id)).rejects.toBe(dbDown);
    });
  });
});
