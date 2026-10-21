import { Logger, NotFoundException } from '@nestjs/common';
import { AdminProductsService } from './admin-products.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CreateProductDto } from './dto/create-product.dto.js';
import { MasterCardImageUnavailableError } from './master-card-image-downloader.js';

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
    marketReferences: [],
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
  let downloader: { download: ReturnType<typeof vi.fn> };
  let prisma: {
    masterCard: { findUnique: ReturnType<typeof vi.fn> };
    product: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    productImage: {
      create: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    category: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    productMarketReference: { createMany: ReturnType<typeof vi.fn> };
    productCategory: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    unlinkMock.mockClear();
    prisma = {
      masterCard: { findUnique: vi.fn() },
      product: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      productImage: {
        create: vi.fn(),
        createMany: vi.fn(),
        aggregate: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
      },
      // Story 13.5: tag replacement runs inside the create transaction.
      category: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ id: CATEGORY.id }),
      },
      productMarketReference: { createMany: vi.fn() },
      productCategory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) =>
        cb(prisma),
      ),
    };
    downloader = { download: vi.fn() };
    service = new AdminProductsService(prisma as never, downloader as never);
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

  describe('create from a master card (Story 15.6, AD-57)', () => {
    const CARD_ID = '0b8f6c52-6d0e-4a3e-9d57-2b6f6f1c1111';
    const card = (over: Record<string, unknown> = {}) => ({
      id: CARD_ID,
      externalId: '12345',
      name: 'Charizard ex',
      franchise: 'POKEMON',
      setName: '151',
      cardNumber: '199/165',
      rarity: 'Special Illustration Rare',
      printing: 'Normal',
      editionLanguage: 'EN',
      tcgplayerId: 777,
      imageLarge: 'https://product-images.tcgplayer.com/l.jpg',
      imageSmall: 'https://product-images.tcgplayer.com/s.jpg',
      marketPriceUsd: '12.34',
      ...over,
    });
    const dto = { masterCardId: CARD_ID, stock: 3 } as CreateProductDto;
    const downloaded = {
      filename: 'dl-1.jpg',
      path: '/tmp/uploads/public/products/dl-1.jpg',
    };

    beforeEach(() => {
      prisma.masterCard.findUnique.mockResolvedValue(card());
      downloader.download.mockResolvedValue(downloaded);
      prisma.product.create.mockResolvedValue(buildProductRow());
      prisma.productImage.create.mockResolvedValue({});
      prisma.product.findUnique.mockResolvedValue(buildProductRow());
    });

    it('maps the card, takes priceUsd as is and removes ignored uploaded files', async () => {
      const uploaded = buildFile();
      await service.create(dto, [uploaded]);

      expect(unlinkMock).toHaveBeenCalledWith(uploaded.path);
      expect(downloader.download).toHaveBeenCalledWith([
        'https://product-images.tcgplayer.com/l.jpg',
        'https://product-images.tcgplayer.com/s.jpg',
      ]);
      const data = (
        prisma.product.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(data).toMatchObject({
        name: 'Charizard ex',
        slug: 'charizard-ex-151-199-165-tcg-12345',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'SECRET_RARE',
        editionLanguage: 'EN',
        priceUsd: '12.34',
        stock: 3,
        categoryId: CATEGORY.id,
        masterCardId: CARD_ID,
        isManual: false,
        autoSyncPrice: true,
      });
      expect(data.lastMarketSyncAt).toBeInstanceOf(Date);
      expect(prisma.productImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          url: '/uploads/public/products/dl-1.jpg',
          sortOrder: 0,
        }) as unknown,
      });
      expect(prisma.productMarketReference.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            provider: 'TCGPLAYER',
            url: 'https://www.tcgplayer.com/product/777',
          }),
        ],
      });
    });

    it('404 MASTER_CARD_NOT_FOUND without downloading anything', async () => {
      prisma.masterCard.findUnique.mockResolvedValue(null);
      await expect(service.create(dto, [])).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'MASTER_CARD_NOT_FOUND' },
      });
      expect(downloader.download).not.toHaveBeenCalled();
    });

    it('422 MASTER_CARD_NO_PRICE for a card without market price', async () => {
      prisma.masterCard.findUnique.mockResolvedValue(
        card({ marketPriceUsd: null }),
      );
      await expect(service.create(dto, [])).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'MASTER_CARD_NO_PRICE' },
      });
      expect(downloader.download).not.toHaveBeenCalled();
    });

    it('502 MASTER_CARD_IMAGE_UNAVAILABLE and no transaction when the download fails', async () => {
      downloader.download.mockRejectedValue(
        new MasterCardImageUnavailableError('nope'),
      );
      await expect(service.create(dto, [])).rejects.toMatchObject({
        status: 502,
        response: { errorCode: 'MASTER_CARD_IMAGE_UNAVAILABLE' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('deletes the downloaded file when the transaction fails (R5)', async () => {
      prisma.productImage.create.mockRejectedValue(new Error('boom'));
      await expect(service.create(dto, [])).rejects.toThrow('boom');
      expect(unlinkMock).toHaveBeenCalledWith(downloaded.path);
    });

    it('retries the slug with -2 on P2002 (second product of the same card)', async () => {
      prisma.product.create
        .mockRejectedValueOnce(knownRequestError('P2002'))
        .mockResolvedValueOnce(buildProductRow());
      await service.create(dto, []);
      const slugs = prisma.product.create.mock.calls.map(
        (c) => (c[0] as { data: { slug: string } }).data.slug,
      );
      expect(slugs).toEqual([
        'charizard-ex-151-199-165-tcg-12345',
        'charizard-ex-151-199-165-tcg-12345-2',
      ]);
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it('gives up with 409 PRODUCT_SLUG_TAKEN after 5 slug attempts and removes the file', async () => {
      prisma.product.create.mockRejectedValue(knownRequestError('P2002'));
      await expect(service.create(dto, [])).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'PRODUCT_SLUG_TAKEN' },
      });
      expect(prisma.product.create).toHaveBeenCalledTimes(5);
      expect(unlinkMock).toHaveBeenCalledWith(downloaded.path);
    });
  });

  describe('update autoSyncPrice (Story 15.6, A36)', () => {
    it('409 NOT_A_LINKED_PRODUCT when the Product has no masterCardId', async () => {
      prisma.product.findUnique.mockResolvedValue({ masterCardId: null });
      await expect(
        service.update('p1', { autoSyncPrice: false }),
      ).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'NOT_A_LINKED_PRODUCT' },
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('persists autoSyncPrice on a linked Product', async () => {
      prisma.product.findUnique
        .mockResolvedValueOnce({ masterCardId: 'mc' })
        .mockResolvedValue(buildProductRow());
      prisma.product.update.mockResolvedValue(buildProductRow());
      await service.update('p1', { autoSyncPrice: false });
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { autoSyncPrice: false },
      });
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
          // Story 13.5: tags loaded by one batched relation query.
          taxonomyTags: expect.any(Object) as unknown,
          images: { orderBy: { sortOrder: 'asc' } },
          marketReferences: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
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

  describe('update (marketReferences, Story 11.4)', () => {
    const REF = {
      provider: 'CARDMARKET' as const,
      label: 'Cardmarket',
      url: 'https://www.cardmarket.com/x',
      suggestedPriceEur: 12.5,
    };

    const refs = {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    };

    beforeEach(() => {
      refs.deleteMany.mockClear();
      refs.createMany.mockClear();
      (prisma as Record<string, unknown>).productMarketReference = refs;
      prisma.product.update.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(buildProductRow());
    });

    it('omitted marketReferences: no transaction, references untouched', async () => {
      await service.update(buildProductRow().id, { name: 'X' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(refs.deleteMany).not.toHaveBeenCalled();
    });

    it('array replaces all references inside one transaction, sortOrder = position', async () => {
      const id = buildProductRow().id;
      await service.update(id, {
        marketReferences: [REF, { ...REF, url: 'https://b.test' }],
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(refs.deleteMany).toHaveBeenCalledWith({
        where: { productId: id },
      });
      expect(refs.createMany).toHaveBeenCalledWith({
        data: [
          { productId: id, ...REF, sortOrder: 0 },
          { productId: id, ...REF, url: 'https://b.test', sortOrder: 1 },
        ],
      });
    });

    it('[] clears references without createMany', async () => {
      await service.update(buildProductRow().id, { marketReferences: [] });
      expect(refs.deleteMany).toHaveBeenCalled();
      expect(refs.createMany).not.toHaveBeenCalled();
    });

    it('rejects duplicate (provider,url) with 400 before touching the DB', async () => {
      await expect(
        service.update(buildProductRow().id, {
          marketReferences: [REF, REF],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
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

  describe('removeImage (Story 12.1)', () => {
    const PRODUCT_ID = 'f65915f5-2931-4e50-af95-630b1fd7b950';
    const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
    const IMAGE_URL = '/uploads/public/products/abc.png';

    it('locks the parent Product row, deletes the row and unlinks the file post-commit', async () => {
      prisma.productImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        url: IMAGE_URL,
      });
      prisma.productImage.count.mockResolvedValue(2);

      await service.removeImage(PRODUCT_ID, IMAGE_ID);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.productImage.delete).toHaveBeenCalledWith({
        where: { id: IMAGE_ID },
      });
      expect(unlinkMock).toHaveBeenCalledTimes(1);
      expect(String(unlinkMock.mock.calls[0][0])).toMatch(
        /uploads\/public\/products\/abc\.png$/,
      );
    });

    it('the last image: 400 PRODUCT_IMAGE_REQUIRED, nothing deleted or unlinked', async () => {
      prisma.productImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        url: IMAGE_URL,
      });
      prisma.productImage.count.mockResolvedValue(1);

      const thrown: unknown = await service
        .removeImage(PRODUCT_ID, IMAGE_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'PRODUCT_IMAGE_REQUIRED' },
      });
      expect(prisma.productImage.delete).not.toHaveBeenCalled();
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it('an unknown Product: 404', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(
        service.removeImage(PRODUCT_ID, IMAGE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.productImage.delete).not.toHaveBeenCalled();
    });

    it('an unknown image or an image of another Product: 404', async () => {
      prisma.productImage.findFirst.mockResolvedValue(null);
      await expect(
        service.removeImage(PRODUCT_ID, IMAGE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.productImage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: IMAGE_ID, productId: PRODUCT_ID },
        }),
      );
      expect(prisma.productImage.delete).not.toHaveBeenCalled();
    });

    it('ENOENT on unlink: silent 204 path (resolves)', async () => {
      prisma.productImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        url: IMAGE_URL,
      });
      prisma.productImage.count.mockResolvedValue(2);
      unlinkMock.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { code: 'ENOENT' }),
      );
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.removeImage(PRODUCT_ID, IMAGE_ID),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('another unlink error: still resolves, logged with Logger.warn', async () => {
      prisma.productImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        url: IMAGE_URL,
      });
      prisma.productImage.count.mockResolvedValue(2);
      unlinkMock.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.removeImage(PRODUCT_ID, IMAGE_ID),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('a url that traverses outside the public uploads dir is NOT unlinked (still 204, warned)', async () => {
      prisma.productImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        url: '/uploads/public/../../etc/passwd',
      });
      prisma.productImage.count.mockResolvedValue(2);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.removeImage(PRODUCT_ID, IMAGE_ID),
      ).resolves.toBeUndefined();
      expect(unlinkMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('reorderImages (Story 12.1)', () => {
    const PRODUCT_ID = 'f65915f5-2931-4e50-af95-630b1fd7b950';
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const C = '33333333-3333-4333-8333-333333333333';

    beforeEach(() => {
      prisma.productImage.findMany.mockResolvedValue([
        { id: A },
        { id: B },
        { id: C },
      ]);
      prisma.product.findUnique.mockResolvedValue(buildProductRow());
    });

    it('a valid permutation reassigns sortOrder 0..n-1 in the given order', async () => {
      await service.reorderImages(PRODUCT_ID, { imageIds: [C, A, B] });

      expect(prisma.productImage.update.mock.calls).toEqual([
        [{ where: { id: C }, data: { sortOrder: 0 } }],
        [{ where: { id: A }, data: { sortOrder: 1 } }],
        [{ where: { id: B }, data: { sortOrder: 2 } }],
      ]);
    });

    it.each([
      ['missing', [A, B]],
      ['extra/foreign', [A, B, C, '44444444-4444-4444-8444-444444444444']],
      ['foreign replacing one', [A, B, '44444444-4444-4444-8444-444444444444']],
      ['duplicate', [A, A, B]],
    ])('%s ids: 400 INVALID_IMAGE_ORDER, nothing written', async (_n, ids) => {
      const thrown: unknown = await service
        .reorderImages(PRODUCT_ID, { imageIds: ids })
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'INVALID_IMAGE_ORDER' },
      });
      expect(prisma.productImage.update).not.toHaveBeenCalled();
    });

    it('an unknown Product: 404', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(
        service.reorderImages(PRODUCT_ID, { imageIds: [A, B, C] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('tags (Story 13.5, AD-38)', () => {
    const POKE = {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'franchise-pokemon',
    };
    const BOX = {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'format-booster-box',
    };
    const OLD = {
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'franchise-topps',
    };
    const CUSTOM = {
      id: '44444444-4444-4444-8444-444444444444',
      slug: 'my-set',
    };

    it('merges derived tags, drops other seeded tags, keeps custom ones, de-duplicates', async () => {
      prisma.product.create.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(buildProductRow());
      prisma.category.findMany.mockResolvedValue([POKE, BOX, OLD, CUSTOM]);

      await service.create(
        {
          ...CREATE_DTO,
          productType: 'BOOSTER_BOX',
          categoryIds: [OLD.id, CUSTOM.id, CUSTOM.id],
        },
        [buildFile()],
      );

      const data = prisma.productCategory.createMany.mock.calls[0][0] as {
        data: { categoryId: string }[];
        skipDuplicates: boolean;
      };
      expect(data.skipDuplicates).toBe(true);
      expect(data.data.map((d) => d.categoryId).sort()).toEqual(
        [CUSTOM.id, POKE.id, BOX.id].sort(),
      );
    });

    it('unknown id -> 400 CATEGORY_NOT_FOUND and the files are cleaned up', async () => {
      prisma.product.create.mockResolvedValue(buildProductRow());
      prisma.category.findMany.mockResolvedValue([POKE]);

      const thrown: unknown = await service
        .create({ ...CREATE_DTO, categoryIds: [CUSTOM.id] }, [buildFile()])
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'CATEGORY_NOT_FOUND' },
      });
      expect(prisma.productCategory.createMany).not.toHaveBeenCalled();
      expect(unlinkMock).toHaveBeenCalled();
    });

    it('PATCH without categoryIds/enums does not touch tags', async () => {
      prisma.product.update.mockResolvedValue(buildProductRow());
      prisma.product.findUnique.mockResolvedValue(buildProductRow());

      await service.update(buildProductRow().id, { name: 'x' });

      expect(prisma.productCategory.deleteMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('PATCH categoryIds: [] replaces all non-derived tags', async () => {
      prisma.product.update.mockResolvedValue({
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        taxonomyTags: [],
      });
      prisma.product.findUnique.mockResolvedValue(buildProductRow());
      prisma.category.findMany.mockResolvedValue([POKE]);

      await service.update(buildProductRow().id, { categoryIds: [] });

      expect(prisma.productCategory.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.productCategory.createMany).toHaveBeenCalledWith({
        data: [{ productId: buildProductRow().id, categoryId: POKE.id }],
        skipDuplicates: true,
      });
    });
  });
});
