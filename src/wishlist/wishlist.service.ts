import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../common/api-exception.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WISHLIST_COOKIE_TTL_MS } from './wishlist-cookie.service.js';
import type { WishlistResponseDto } from './dto/wishlist.dto.js';

/** AD-22: maximum saved items per wishlist (soft check, see addItem). */
export const WISHLIST_MAX_ITEMS = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Story 11.5 (FR-36, AD-22): read-only (never refreshes the TTL). Any
   * missing/invalid/expired/unknown wishlist yields an empty list. Inactive
   * products are omitted from both `data` and `productIds`.
   */
  async getWishlist(wishlistId: string | null): Promise<WishlistResponseDto> {
    if (!wishlistId || !UUID_RE.test(wishlistId)) {
      return { data: [], productIds: [] };
    }
    const items = await this.prisma.wishlistItem.findMany({
      where: {
        wishlistId,
        wishlist: { expiresAt: { gt: new Date() } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { productId: true },
    });
    const data = await this.catalog.findListItemsByIds(
      items.map((item) => item.productId),
    );
    return { data, productIds: data.map((item) => item.id) };
  }

  /**
   * Adds a product (idempotent, race-safe via `INSERT ... ON CONFLICT DO
   * NOTHING`, never `upsert` — lesson of Story 7.2). Returns the wishlist id
   * (existing, refreshed, or newly created) and the active saved product ids.
   */
  async addItem(
    wishlistId: string | null,
    productId: string,
  ): Promise<{ wishlistId: string; productIds: string[] }> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId, isActive: true },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const expiresAt = new Date(Date.now() + WISHLIST_COOKIE_TTL_MS);
    let id: string | null = null;
    if (wishlistId && UUID_RE.test(wishlistId)) {
      // Sliding expiry; matches nothing when expired/unknown.
      const refreshed = await this.prisma.wishlist.updateMany({
        where: { id: wishlistId, expiresAt: { gt: new Date() } },
        data: { expiresAt },
      });
      if (refreshed.count > 0) {
        id = wishlistId;
      }
    }
    if (!id) {
      const created = await this.prisma.wishlist.create({
        data: { expiresAt },
        select: { id: true },
      });
      id = created.id;
    }

    // Soft cap (AD-22): a concurrent race may exceed it by a few items.
    const alreadySaved = await this.prisma.wishlistItem.findUnique({
      where: { wishlistId_productId: { wishlistId: id, productId } },
      select: { id: true },
    });
    if (!alreadySaved) {
      const count = await this.prisma.wishlistItem.count({
        where: { wishlistId: id },
      });
      if (count >= WISHLIST_MAX_ITEMS) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'WISHLIST_FULL',
          `A wishlist can hold at most ${WISHLIST_MAX_ITEMS} items.`,
          { maxItems: WISHLIST_MAX_ITEMS },
        );
      }
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "Wishlist_Items" ("id", "wishlistId", "productId")
          VALUES (${randomUUID()}::uuid, ${id}::uuid, ${productId}::uuid)
          ON CONFLICT ("wishlistId", "productId") DO NOTHING
        `,
      );
    }

    const rows = await this.prisma.wishlistItem.findMany({
      where: { wishlistId: id, product: { isActive: true } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { productId: true },
    });
    return { wishlistId: id, productIds: rows.map((row) => row.productId) };
  }

  /** Idempotent: removes the pair if present; no cookie/unknown is a no-op. */
  async removeItem(
    wishlistId: string | null,
    productId: string,
  ): Promise<void> {
    if (!wishlistId || !UUID_RE.test(wishlistId)) {
      return;
    }
    await this.prisma.wishlistItem.deleteMany({
      where: { wishlistId, productId },
    });
  }
}
