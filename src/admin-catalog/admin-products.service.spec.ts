import { NotFoundException } from '@nestjs/common';
import { AdminProductsService } from './admin-products.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CreateProductDto } from './dto/create-product.dto.js';

const unlinkMock = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  unlink: (...args: unknown[]) =>
    (unlinkMock as (...a: unknown[]) => unknown)(...args),
}));

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

function buildFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'images',
    originalname: '../../etc/passwd',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 12345,
    destination: '/tmp/uploads/public/products',
    filename: 'generated-uuid-1.png',
    path: '/tmp/uploads/public/products/generated-uuid-1.png',
    buffer: Buffer.from(''),
    stream: undefined as never,
    ...overrides,
  };
}

const CATEGORY = {
  id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
  name: 'Cartas Sueltas',
  slug: 'cartas-sueltas',
};

function buildProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
    name: 'Blastoise VMAX',
    slug: 'blastoise-vmax',
    description: 'Carta individual Blastoise VMAX.',
    franchise: 'POKEMON',
    productType: 'SINGLE_CARD',
    rarity: 'ULTRA_RARE',
    priceUsd: '79.99',
    stock: 25,
    heldQty: 0,
    isActive: true,
    isPreorder: false,
    releaseDate: null,
    gradingCompany: null,
    gradeValue: null,
    certNumber: null,
    categoryId: CATEGORY.id,
    category: CATEGORY,
    images: [
      {
        id: 'img-1',
        url: '/uploads/public/products/generated-uuid-1.png',
        altText: null,
        sortOrder: 0,
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const CREATE_DTO: CreateProductDto = {
  name: 'Blastoise VMAX',
  slug: 'blastoise-vmax',
  description: 'Carta individual Blastoise VMAX.',
  franchise: 'POKEMON',
  productType: 'SINGLE_CARD',
  rarity: 'ULTRA_RARE',
  priceUsd: 79.99,
  stock: 25,
  categoryId: CATEGORY.id,
};

/**
 * Story 8.2. Unit-level coverage of `AdminProductsService`'s Prisma-error-
 * translation and delete-vs-deactivate branches — same split
 * `AdminCategoriesService`/`AdminCategoriesService.spec.ts` already
 * established: this suite mocks PrismaService entirely (and `node:fs/
 * promises#unlink`, same technique `ProofOfPaymentService.spec.ts` uses)
 * so every branch is exercised on demand; `test/admin-products.e2e-spec.ts`
 * covers the real end-to-end wiring (guard, real Postgres, real multer
 * disk writes, real static file serving) instead.
 */
describe('AdminProductsService', () => {
  let service: AdminProductsService;
  let prisma: {
    product: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    productImage: {
      createMany: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    unlinkMock.mockClear();
    prisma = {
      product: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      productImage: {
        createMany: vi.fn(),
        aggregate: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) =>
        cb(prisma),
      ),
    };
    service = new AdminProductsService(prisma as never);
  });

  describe('create', () => {
    it('rejects with 400 PRODUCT_IMAGE_REQUIRED when no image files are sent — nothing touches Prisma', async () => {
      const thrown: unknown = await service
        .create(CREATE_DTO, [])
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'PRODUCT_IMAGE_REQUIRED' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates the Product + ProductImage row(s) inside one transaction and returns the full admin DTO', async () => {
      const file = buildFile();
      prisma.product.create.mockResolvedValue(
        buildProductRow({ images: undefined, category: undefined }),
      );
      prisma.productImage.createMany.mockResolvedValue({ count: 1 });
      prisma.product.findUnique.mockResolvedValue(buildProductRow());

      const result = await service.create(CREATE_DTO, [file]);

      expect(prisma.product.create).toHaveBeenCalledWith({
        data: {
          name: CREATE_DTO.name,
          slug: CREATE_DTO.slug,
          description: CREATE_DTO.description,
          franchise: CREATE_DTO.franchise,
          productType: CREATE_DTO.productType,
          rarity: CREATE_DTO.rarity,
          priceUsd: CREATE_DTO.priceUsd,
          stock: CREATE_DTO.stock,
          categoryId: CREATE_DTO.categoryId,
        },
      });
      expect(prisma.productImage.createMany).toHaveBeenCalledWith({
        data: [
          {
            productId: buildProductRow().id,
            url: '/uploads/public/products/generated-uuid-1.png',
            altText: null,
            sortOrder: 0,
          },
        ],
      });
      expect(result.isActive).toBe(true);
      expect(result.priceUsd).toBe(79.99);
      expect(result.images).toHaveLength(1);
      expect(result.isPreorder).toBe(false);
      expect(result.releaseDate).toBeNull();
      expect(result.gradingCompany).toBeNull();
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it('persists the optional preorder/grading fields and returns them in the admin DTO', async () => {
      const file = buildFile();
      prisma.product.create.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(
        buildProductRow({
          isPreorder: true,
          releaseDate: new Date('2027-01-15T00:00:00.000Z'),
          gradingCompany: 'PSA',
          gradeValue: '10',
          certNumber: 'AB123',
        }),
      );

      const result = await service.create(
        {
          ...CREATE_DTO,
          isPreorder: true,
          releaseDate: '2027-01-15T00:00:00.000Z',
          gradingCompany: 'PSA',
          gradeValue: '10',
          certNumber: 'AB123',
        },
        [file],
      );

      expect(prisma.product.create).toHaveBeenCalledWith({
        data: {
          name: CREATE_DTO.name,
          slug: CREATE_DTO.slug,
          description: CREATE_DTO.description,
          franchise: CREATE_DTO.franchise,
          productType: CREATE_DTO.productType,
          rarity: CREATE_DTO.rarity,
          priceUsd: CREATE_DTO.priceUsd,
          stock: CREATE_DTO.stock,
          categoryId: CREATE_DTO.categoryId,
          isPreorder: true,
          releaseDate: new Date('2027-01-15T00:00:00.000Z'),
          gradingCompany: 'PSA',
          gradeValue: '10',
          certNumber: 'AB123',
        },
      });
      expect(result).toMatchObject({
        isPreorder: true,
        releaseDate: '2027-01-15T00:00:00.000Z',
        gradingCompany: 'PSA',
        gradeValue: '10',
        certNumber: 'AB123',
      });
    });

    it('translates a P2002 (duplicate slug) into 409 PRODUCT_SLUG_TAKEN and cleans up the now-orphaned uploaded file(s)', async () => {
      const file = buildFile();
      prisma.product.create.mockRejectedValue(knownRequestError('P2002'));

      const thrown: unknown = await service
        .create(CREATE_DTO, [file])
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 409,
        response: { errorCode: 'PRODUCT_SLUG_TAKEN' },
      });
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });

    it('translates a P2003 (unknown categoryId) into 400 CATEGORY_NOT_FOUND and cleans up the uploaded file(s)', async () => {
      const file = buildFile();
      prisma.product.create.mockRejectedValue(knownRequestError('P2003'));

      const thrown: unknown = await service
        .create(CREATE_DTO, [file])
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'CATEGORY_NOT_FOUND' },
      });
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });

    it('rethrows any other error untouched, still cleaning up the uploaded file(s)', async () => {
      const file = buildFile();
      const dbDown = new Error('connection refused');
      prisma.product.create.mockRejectedValue(dbDown);

      await expect(service.create(CREATE_DTO, [file])).rejects.toBe(dbDown);
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });
  });

  describe('findAll / findOne', () => {
    it('findAll returns every Product mapped to the admin DTO shape, regardless of isActive', async () => {
      prisma.product.findMany.mockResolvedValue([
        buildProductRow({ isActive: false }),
      ]);

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(result[0].isActive).toBe(false);
      expect(prisma.product.findMany).toHaveBeenCalledWith({
        include: {
          category: true,
          images: { orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { name: 'asc' },
      });
    });

    it('findOne throws NotFoundException when no Product matches the id', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('sends only the defined fields to Prisma (partial update)', async () => {
      prisma.product.update.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(
        buildProductRow({ priceUsd: '99.99' }),
      );

      await service.update(buildProductRow().id, { priceUsd: 99.99 });

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: buildProductRow().id },
        data: { priceUsd: 99.99 },
      });
    });

    it('PATCH { isActive: false } deactivates without touching any other field', async () => {
      prisma.product.update.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(
        buildProductRow({ isActive: false }),
      );

      const result = await service.update(buildProductRow().id, {
        isActive: false,
      });

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: buildProductRow().id },
        data: { isActive: false },
      });
      expect(result.isActive).toBe(false);
    });

    it('throws NotFoundException on P2025 (no such Product)', async () => {
      prisma.product.update.mockRejectedValue(knownRequestError('P2025'));

      await expect(
        service.update('00000000-0000-0000-0000-000000000000', {
          name: 'X',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('translates a P2002 (duplicate slug) into 409 PRODUCT_SLUG_TAKEN', async () => {
      prisma.product.update.mockRejectedValue(knownRequestError('P2002'));

      const thrown: unknown = await service
        .update(buildProductRow().id, { slug: 'ya-existe' })
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 409,
        response: { errorCode: 'PRODUCT_SLUG_TAKEN' },
      });
    });

    it('translates a P2003 (unknown categoryId) into 400 CATEGORY_NOT_FOUND', async () => {
      prisma.product.update.mockRejectedValue(knownRequestError('P2003'));

      const thrown: unknown = await service
        .update(buildProductRow().id, {
          categoryId: '00000000-0000-0000-0000-000000000000',
        })
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'CATEGORY_NOT_FOUND' },
      });
    });
  });

  describe('adjustStock', () => {
    it('writes ONLY stock to Prisma — never touches heldQty', async () => {
      prisma.product.update.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(
        buildProductRow({ stock: 40 }),
      );

      const result = await service.adjustStock(buildProductRow().id, {
        stock: 40,
      });

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: buildProductRow().id },
        data: { stock: 40 },
      });
      expect(result.stock).toBe(40);
    });

    it('throws NotFoundException on P2025 (no such Product)', async () => {
      prisma.product.update.mockRejectedValue(knownRequestError('P2025'));

      await expect(
        service.adjustStock('00000000-0000-0000-0000-000000000000', {
          stock: 5,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rethrows any other error untouched', async () => {
      const dbDown = new Error('connection refused');
      prisma.product.update.mockRejectedValue(dbDown);

      await expect(
        service.adjustStock(buildProductRow().id, { stock: 5 }),
      ).rejects.toBe(dbDown);
    });
  });

  describe('remove — delete-vs-deactivate policy', () => {
    it('throws NotFoundException when no Product matches the id, never attempting the delete', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });

    it('a Product with no historical references: real DELETE succeeds, its image file(s) are best-effort unlinked, hardDeleted: true', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: buildProductRow().id,
        images: [{ url: '/uploads/public/products/generated-uuid-1.png' }],
      });
      prisma.product.delete.mockResolvedValue(buildProductRow());

      const result = await service.remove(buildProductRow().id);

      expect(result).toEqual({ id: buildProductRow().id, hardDeleted: true });
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(unlinkMock).toHaveBeenCalledTimes(1);
    });

    it('a Product referenced by >=1 historical OrderLine/CartItem/StockHold (P2003): falls back to isActive=false, hardDeleted: false, never unlinks any file', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: buildProductRow().id,
        images: [{ url: '/uploads/public/products/generated-uuid-1.png' }],
      });
      prisma.product.delete.mockRejectedValue(knownRequestError('P2003'));
      prisma.product.update.mockResolvedValue(
        buildProductRow({ isActive: false }),
      );

      const result = await service.remove(buildProductRow().id);

      expect(result).toEqual({
        id: buildProductRow().id,
        hardDeleted: false,
      });
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: buildProductRow().id },
        data: { isActive: false },
      });
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it('throws NotFoundException on P2025 racing the delete itself', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: buildProductRow().id,
        images: [],
      });
      prisma.product.delete.mockRejectedValue(knownRequestError('P2025'));

      await expect(service.remove(buildProductRow().id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('addImages', () => {
    it('rejects with 400 PRODUCT_IMAGE_REQUIRED when no files are sent', async () => {
      const thrown: unknown = await service
        .addImages(buildProductRow().id, [])
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'PRODUCT_IMAGE_REQUIRED' },
      });
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
    });

    it('a missing Product: 404, and the already-uploaded file(s) are cleaned up', async () => {
      const file = buildFile();
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.addImages('00000000-0000-0000-0000-000000000000', [file]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });

    it('appends new ProductImage rows, continuing sortOrder after existing images', async () => {
      const file = buildFile({ filename: 'generated-uuid-2.png' });
      prisma.product.findUnique
        .mockResolvedValueOnce({ id: buildProductRow().id })
        .mockResolvedValueOnce(buildProductRow());
      prisma.productImage.aggregate.mockResolvedValue({
        _max: { sortOrder: 2 },
      });
      prisma.productImage.createMany.mockResolvedValue({ count: 1 });

      await service.addImages(buildProductRow().id, [file]);

      expect(prisma.productImage.createMany).toHaveBeenCalledWith({
        data: [
          {
            productId: buildProductRow().id,
            url: '/uploads/public/products/generated-uuid-2.png',
            altText: null,
            sortOrder: 3,
          },
        ],
      });
    });

    it('starts sortOrder at 0 when the Product has no existing images', async () => {
      const file = buildFile();
      prisma.product.findUnique
        .mockResolvedValueOnce({ id: buildProductRow().id })
        .mockResolvedValueOnce(buildProductRow());
      prisma.productImage.aggregate.mockResolvedValue({
        _max: { sortOrder: null },
      });
      prisma.productImage.createMany.mockResolvedValue({ count: 1 });

      await service.addImages(buildProductRow().id, [file]);

      expect(prisma.productImage.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ sortOrder: 0 })],
      });
    });
  });
});
