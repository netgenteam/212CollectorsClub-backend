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
  async getWishlist(
    wishlistId: string | null,
    customerId?: string | null,
  ): Promise<WishlistResponseDto> {
    if (!customerId && (!wishlistId || !UUID_RE.test(wishlistId))) {
      return { data: [], productIds: [] };
    }
    const items = await this.prisma.wishlistItem.findMany({
      // Account wishlists (Story 12.5) are owned, not cookie-expiring.
      where: customerId
        ? { wishlist: { customerId } }
        : {
            wishlistId: wishlistId as string,
            wishlist: { customerId: null, expiresAt: { gt: new Date() } },
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
    customerId?: string | null,
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
    if (customerId) {
      id = await this.ensureAccountWishlist(customerId, expiresAt);
    } else if (wishlistId && UUID_RE.test(wishlistId)) {
      // Sliding expiry; matches nothing when expired/unknown.
      const refreshed = await this.prisma.wishlist.updateMany({
        where: {
          id: wishlistId,
          customerId: null,
          expiresAt: { gt: new Date() },
        },
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
    customerId?: string | null,
  ): Promise<void> {
    if (customerId) {
      await this.prisma.wishlistItem.deleteMany({
        where: { productId, wishlist: { customerId } },
      });
      return;
    }
    if (!wishlistId || !UUID_RE.test(wishlistId)) {
      return;
    }
    await this.prisma.wishlistItem.deleteMany({
      where: { wishlistId, productId, wishlist: { customerId: null } },
    });
  }

  // ---------------------------------------------------------------------
  // Story 12.5 (FR-44, AD-29): account-bound wishlist + merge on login
  // ---------------------------------------------------------------------

  private async lockAccountWishlist(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'wishlist:' + customerId}, 0))`,
    );
  }

  /** Account wishlist, created on demand (under the account lock). */
  private ensureAccountWishlist(
    customerId: string,
    expiresAt: Date,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccountWishlist(tx, customerId);
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "Wishlists" ("id", "customerId", "expiresAt", "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${customerId}::uuid, ${expiresAt}, now(), now())
        ON CONFLICT ("customerId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
        RETURNING id
      `);
      return rows[0].id;
    });
  }

  /**
   * AD-29/AD-22: unions the anonymous wishlist into the account's with
   * `INSERT ... ON CONFLICT DO NOTHING` (200-item cap respected by trimming,
   * never an error), then deletes the anonymous one. The anonymous row is
   * claimed by a guarded `UPDATE ... WHERE customerId IS NULL`, so a second
   * concurrent merge of the same cookie is a no-op. Returns true when this
   * call consumed the anonymous wishlist.
   */
  async mergeAnonymousWishlist(
    customerId: string,
    anonWishlistId: string,
  ): Promise<boolean> {
    if (!UUID_RE.test(anonWishlistId)) {
      return false;
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccountWishlist(tx, customerId);
      const expiresAt = new Date(Date.now() + WISHLIST_COOKIE_TTL_MS);

      const account = await tx.wishlist.findUnique({
        where: { customerId },
        select: { id: true },
      });

      if (!account) {
        const assigned = await tx.$executeRaw(Prisma.sql`
          UPDATE "Wishlists"
          SET "customerId" = ${customerId}::uuid, "expiresAt" = ${expiresAt}, "updatedAt" = now()
          WHERE id = ${anonWishlistId}::uuid AND "customerId" IS NULL AND "expiresAt" > now()
        `);
        return assigned > 0;
      }

      const claimed = await tx.$executeRaw(Prisma.sql`
        UPDATE "Wishlists" SET "updatedAt" = now()
        WHERE id = ${anonWishlistId}::uuid AND "customerId" IS NULL AND "expiresAt" > now()
      `);
      if (claimed === 0) {
        return false;
      }

      const current = await tx.wishlistItem.count({
        where: { wishlistId: account.id },
      });
      const room = Math.max(WISHLIST_MAX_ITEMS - current, 0);
      if (room > 0) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "Wishlist_Items" ("id", "wishlistId", "productId", "createdAt")
          SELECT gen_random_uuid(), ${account.id}::uuid, wi."productId", wi."createdAt"
          FROM "Wishlist_Items" wi
          JOIN "Products" p ON p.id = wi."productId" AND p."isActive"
          WHERE wi."wishlistId" = ${anonWishlistId}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM "Wishlist_Items" ex
              WHERE ex."wishlistId" = ${account.id}::uuid AND ex."productId" = wi."productId")
          ORDER BY wi."createdAt" DESC, wi.id DESC
          LIMIT ${room}
          ON CONFLICT ("wishlistId", "productId") DO NOTHING
        `);
      }
      await tx.$executeRaw(
        Prisma.sql`UPDATE "Wishlists" SET "expiresAt" = ${expiresAt}, "updatedAt" = now() WHERE id = ${account.id}::uuid`,
      );
      await tx.wishlist.deleteMany({
        where: { id: anonWishlistId, customerId: null },
      });
      return true;
    });
  }
}
