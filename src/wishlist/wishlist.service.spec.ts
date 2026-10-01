import { NotFoundException } from '@nestjs/common';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { WISHLIST_MAX_ITEMS, WishlistService } from './wishlist.service.js';

const WID = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';

function build() {
  const prisma = {
    product: { findUnique: vi.fn().mockResolvedValue({ id: PID }) },
    wishlist: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: WID }),
    },
    wishlistItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const catalog = { findListItemsByIds: vi.fn().mockResolvedValue([]) };
  const service = new WishlistService(
    prisma as unknown as PrismaService,
    catalog as unknown as CatalogService,
  );
  return { service, prisma, catalog };
}

describe('WishlistService', () => {
  it('getWishlist returns empty without touching the DB for null/non-UUID ids', async () => {
    const { service, prisma } = build();
    for (const id of [null, 'garbage']) {
      await expect(service.getWishlist(id)).resolves.toEqual({
        data: [],
        productIds: [],
      });
    }
    expect(prisma.wishlistItem.findMany).not.toHaveBeenCalled();
  });

  it('getWishlist derives productIds from the (active-only) catalog result', async () => {
    const { service, prisma, catalog } = build();
    prisma.wishlistItem.findMany.mockResolvedValue([
      { productId: PID },
      { productId: 'gone' },
    ]);
    catalog.findListItemsByIds.mockResolvedValue([{ id: PID }]);
    const res = await service.getWishlist(WID);
    expect(res.productIds).toEqual([PID]);
    expect(catalog.findListItemsByIds).toHaveBeenCalledWith([PID, 'gone']);
  });

  it('addItem 404s on unknown/inactive product and creates nothing', async () => {
    const { service, prisma } = build();
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.addItem(null, PID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.wishlist.create).not.toHaveBeenCalled();
  });

  it('addItem creates a new wishlist when the cookie is absent or the row is gone', async () => {
    const { service, prisma } = build();
    await service.addItem(null, PID);
    expect(prisma.wishlist.create).toHaveBeenCalledTimes(1);
    prisma.wishlist.updateMany.mockResolvedValue({ count: 0 });
    await service.addItem(WID, PID);
    expect(prisma.wishlist.create).toHaveBeenCalledTimes(2);
  });

  it('addItem uses a parameterized INSERT ... ON CONFLICT DO NOTHING (no upsert)', async () => {
    const { service, prisma } = build();
    await service.addItem(WID, PID);
    expect(prisma.wishlist.updateMany).toHaveBeenCalled();
    const sql = prisma.$executeRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(sql.strings.join('?')).toMatch(/ON CONFLICT .* DO NOTHING/);
    expect(sql.values).toContain(PID);
  });

  it('addItem rejects the 201st distinct item with 409 WISHLIST_FULL but allows a repeat at the cap', async () => {
    const { service, prisma } = build();
    prisma.wishlistItem.count.mockResolvedValue(WISHLIST_MAX_ITEMS);
    await expect(service.addItem(WID, PID)).rejects.toMatchObject({
      status: 409,
      response: { errorCode: 'WISHLIST_FULL' },
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    prisma.wishlistItem.findUnique.mockResolvedValue({ id: 'x' });
    await expect(service.addItem(WID, PID)).resolves.toBeDefined();
  });

  it('removeItem is a no-op without a valid id and a scoped deleteMany otherwise', async () => {
    const { service, prisma } = build();
    await service.removeItem(null, PID);
    await service.removeItem('bad', PID);
    expect(prisma.wishlistItem.deleteMany).not.toHaveBeenCalled();
    await service.removeItem(WID, PID);
    expect(prisma.wishlistItem.deleteMany).toHaveBeenCalledWith({
      where: { wishlistId: WID, productId: PID },
    });
  });
});
