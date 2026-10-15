import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  AdminCategoriesService,
  escapeLike,
} from './admin-categories.service.js';
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
  type: 'ROOT' as const,
  dimension: null,
  parentId: null,
  isActive: true,
  sortOrder: 0,
};
const CATEGORY_OUT = { ...CATEGORY, _count: { products: 0 } };
const ID_B = '11111111-1111-4111-8111-111111111111';

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
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
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
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(),
    };
    // The interactive transaction runs against the same mock (acts as `tx`).
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );

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

      expect(result).toEqual(CATEGORY_OUT);
      expect(prisma.category.create).toHaveBeenCalledWith({
        data: {
          name: 'Cartas Sueltas',
          slug: 'cartas-sueltas',
          type: 'ROOT',
          dimension: null,
          parentId: null,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          dimension: true,
          parentId: true,
          isActive: true,
          sortOrder: true,
        },
      });
      // No parent => no tree lock.
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
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

  describe('create with parent', () => {
    it('takes the tree lock, validates placement and creates', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ id: ID_B }]);
      prisma.category.create.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
        parentId: ID_B,
      });
      await service.create({
        name: 'S',
        slug: 's',
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
        parentId: ID_B,
      });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.category.create).toHaveBeenCalled();
    });

    it('rejects a SUBCATEGORY under a depth-3 parent', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]);
      await expect(
        service.create({
          name: 'S',
          slug: 's',
          type: 'SUBCATEGORY',
          dimension: 'CUSTOM',
          parentId: ID_B,
        }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CATEGORY_DEPTH_EXCEEDED' },
      });
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('rejects ROOT + parentId and SUBCATEGORY without dimension before touching the DB', async () => {
      await expect(
        service.create({ name: 'S', slug: 's', parentId: ID_B }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CATEGORY_PARENT_INVALID' },
      });
      await expect(
        service.create({ name: 'S', slug: 's', type: 'SUBCATEGORY' }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CATEGORY_DIMENSION_INVALID' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('search: escapes LIKE wildcards/backslash and passes them as parameters', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ id: CATEGORY.id }]);
      prisma.category.findMany.mockResolvedValue([CATEGORY]);
      await service.findAll({ search: '100%_\\x', isActive: true });
      const sql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(sql.values).toEqual(['%100\\%\\_\\\\x%', '%100\\%\\_\\\\x%']);
      expect(sql.sql).not.toContain('100');
      expect(prisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, id: { in: [CATEGORY.id] } },
        }),
      );
    });

    it('escapeLike escapes backslash first, then % and _', () => {
      expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
    });

    it('returns every Category ordered by name', async () => {
      prisma.category.findMany.mockResolvedValue([CATEGORY]);

      await expect(service.findAll()).resolves.toEqual([CATEGORY_OUT]);
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        where: {},
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          dimension: true,
          parentId: true,
          isActive: true,
          sortOrder: true,
        },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findOne', () => {
    it('returns the Category when it exists', async () => {
      prisma.category.findUnique.mockResolvedValue(CATEGORY);

      await expect(service.findOne(CATEGORY.id)).resolves.toEqual(CATEGORY_OUT);
    });

    it('throws NotFoundException when no Category matches the id', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.category.findUnique.mockResolvedValue(CATEGORY);
    });

    it('sends only the defined fields (plus merged taxonomy state) to Prisma', async () => {
      prisma.category.update.mockResolvedValue({
        ...CATEGORY,
        name: 'New Name',
      });

      await service.update(CATEGORY.id, { name: 'New Name' });

      expect(prisma.category.update).toHaveBeenCalledWith({
        where: { id: CATEGORY.id },
        data: {
          name: 'New Name',
          type: 'ROOT',
          dimension: null,
          parentId: null,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          dimension: true,
          parentId: true,
          isActive: true,
          sortOrder: true,
        },
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the row does not exist', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(
        service.update(CATEGORY.id, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects ROOT + dimension (merged state) with CATEGORY_DIMENSION_INVALID', async () => {
      const thrown: unknown = await service
        .update(CATEGORY.id, { dimension: 'CUSTOM' })
        .catch((e: unknown) => e);
      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'CATEGORY_DIMENSION_INVALID' },
      });
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('SUBCATEGORY -> ROOT without explicit nulls is 400; with nulls it is saved', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
        parentId: ID_B,
      });
      prisma.category.update.mockResolvedValue(CATEGORY);
      await expect(
        service.update(CATEGORY.id, { type: 'ROOT' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.update(CATEGORY.id, {
          type: 'ROOT',
          dimension: null,
          parentId: null,
        }),
      ).resolves.toBeDefined();
    });

    it('self-parent is CATEGORY_CYCLE and takes the tree lock first', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
      });
      const thrown: unknown = await service
        .update(CATEGORY.id, { parentId: CATEGORY.id })
        .catch((e: unknown) => e);
      expect(thrown).toMatchObject({
        response: { errorCode: 'CATEGORY_CYCLE' },
      });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('a descendant as new parent (node in the ancestor chain) is CATEGORY_CYCLE', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
      });
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: ID_B },
        { id: CATEGORY.id },
      ]);
      await expect(
        service.update(CATEGORY.id, { parentId: ID_B }),
      ).rejects.toMatchObject({ response: { errorCode: 'CATEGORY_CYCLE' } });
    });

    it('a missing parent is CATEGORY_PARENT_INVALID', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
      });
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        service.update(CATEGORY.id, { parentId: ID_B }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CATEGORY_PARENT_INVALID' },
      });
    });

    it('ancestors + 1 + subtree height > 3 is CATEGORY_DEPTH_EXCEEDED', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
      });
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: ID_B }, { id: 'r' }]) // parent depth 2
        .mockResolvedValueOnce([{ height: 1 }]); // subtree height 1 => 2+1+1=4
      await expect(
        service.update(CATEGORY.id, { parentId: ID_B }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CATEGORY_DEPTH_EXCEEDED' },
      });
    });

    it('maps a parentId FK violation (parent deleted concurrently) to 400 CATEGORY_PARENT_INVALID', async () => {
      prisma.category.findUnique.mockResolvedValue({
        ...CATEGORY,
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
      });
      prisma.$queryRaw.mockResolvedValueOnce([{ id: ID_B }]);
      prisma.$queryRaw.mockResolvedValueOnce([{ height: 0 }]);
      prisma.category.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK parentId', {
          code: 'P2003',
          clientVersion: '7.10.0',
          meta: { constraint: 'Categories_parentId_fkey' },
        }),
      );
      await expect(
        service.update(CATEGORY.id, { parentId: ID_B }),
      ).rejects.toMatchObject({
        status: 400,
        response: { errorCode: 'CATEGORY_PARENT_INVALID' },
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

    it('translates a parentId FK violation into 409 CATEGORY_HAS_CHILDREN', async () => {
      prisma.category.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK', {
          code: 'P2003',
          clientVersion: '7.10.0',
          meta: { constraint: 'Categories_parentId_fkey' },
        }),
      );
      await expect(service.remove(CATEGORY.id)).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'CATEGORY_HAS_CHILDREN' },
      });
    });

    it('rethrows any other error untouched', async () => {
      const dbDown = new Error('connection refused');
      prisma.category.delete.mockRejectedValue(dbDown);

      await expect(service.remove(CATEGORY.id)).rejects.toBe(dbDown);
    });
  });
});
