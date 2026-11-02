import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type {
  DailyCountEvent,
  SaleEvent,
  ScoringEvents,
  ScoringProduct,
  WishlistEvent,
} from './vitrina.types.js';

const DAY_MS = 86_400_000;
/** Postgres text -> UTC instant, independent of the driver's timestamp handling. */
const ISO_TS = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

export interface LoadedScoringData {
  products: ScoringProduct[];
  events: ScoringEvents;
}

interface ProductRow {
  id: string;
  createdAt: string;
  franchise: string;
  franchiseCat: string | null;
  productType: string;
  availableStock: number;
}
interface SaleRow {
  productId: string;
  qty: number;
  total: number;
  at: string;
}
interface WishRow {
  productId: string;
  at: string;
}
interface StatRow {
  productId: string;
  day: string;
  views: number;
  cartAdds: number;
}

/**
 * Story 18.8 (AD-84, NFR-18.3): reads the ranking inputs with exactly FOUR
 * set-based queries (products, sales, wishlist, daily stats), independent of
 * the catalog size, all bounded by `windowDays`. Runs on the caller's
 * transaction client so the whole run sees one consistent snapshot of the
 * settings it was configured with.
 */
@Injectable()
export class VitrinaDataLoader {
  /** Number of SQL statements `load` issues (asserted by the perf test). */
  static readonly QUERY_COUNT = 4;

  async load(
    tx: Prisma.TransactionClient,
    windowDays: number,
    now: Date,
  ): Promise<LoadedScoringData> {
    const cutoff = new Date(now.getTime() - windowDays * DAY_MS);
    const cutoffTs = cutoff.toISOString();
    const nowTs = now.toISOString();
    const cutoffDay = cutoffTs.slice(0, 10);

    // Sequential on purpose: one interactive-tx connection.
    const products = await tx.$queryRaw<ProductRow[]>(Prisma.sql`
        SELECT p."id", to_char(p."createdAt", ${ISO_TS}) AS "createdAt",
               p."franchise"::text AS "franchise",
               p."productType"::text AS "productType",
               (p."stock" - p."heldQty")::int AS "availableStock",
               CASE WHEN p."franchise" = 'OTHER'::"Franchise" THEN COALESCE(
                 (SELECT MIN(pc."categoryId"::text)
                    FROM "Product_Categories" pc
                    JOIN "Categories" c ON c."id" = pc."categoryId"
                   WHERE pc."productId" = p."id" AND c."dimension" = 'FRANCHISE'::"CategoryDimension"),
                 p."categoryId"::text) END AS "franchiseCat"
        FROM "Products" p
        WHERE p."isActive"`);
    const sales = await tx.$queryRaw<SaleRow[]>(Prisma.sql`
        SELECT ol."productId",
               SUM(ol."quantity")::int AS "qty",
               SUM(ol."lineTotalUsd")::float8 AS "total",
               to_char(MAX(ol."createdAt"), ${ISO_TS}) AS "at"
        FROM "Order_Lines" ol
        JOIN "Orders" o ON o."id" = ol."orderId"
        WHERE o."status" IN ('PAID'::"OrderStatus", 'FULFILLED'::"OrderStatus")
          AND ol."createdAt" >= ${cutoffTs}::timestamp
          AND ol."createdAt" <= ${nowTs}::timestamp
        GROUP BY ol."productId", ol."createdAt"::date`);
    const wishlist = await tx.$queryRaw<WishRow[]>(Prisma.sql`
        SELECT wi."productId", to_char(wi."createdAt", ${ISO_TS}) AS "at"
        FROM "Wishlist_Items" wi
        WHERE wi."createdAt" >= ${cutoffTs}::timestamp
          AND wi."createdAt" <= ${nowTs}::timestamp`);
    const stats = await tx.$queryRaw<StatRow[]>(Prisma.sql`
        SELECT s."productId", to_char(s."day", 'YYYY-MM-DD') AS "day",
               s."views", s."cartAdds"
        FROM "Product_Daily_Stats" s
        WHERE s."day" >= ${cutoffDay}::date`);

    const toDate = (s: string): Date => new Date(s);
    const cartAdds: DailyCountEvent[] = [];
    const views: DailyCountEvent[] = [];
    for (const s of stats) {
      const day = new Date(`${s.day}T00:00:00.000Z`);
      if (s.cartAdds > 0)
        cartAdds.push({ productId: s.productId, day, n: s.cartAdds });
      if (s.views > 0) views.push({ productId: s.productId, day, n: s.views });
    }
    return {
      products: products.map((p): ScoringProduct => ({
        id: p.id,
        createdAt: toDate(p.createdAt),
        franchiseKey:
          p.franchise === 'OTHER' ? `OTHER:${p.franchiseCat}` : p.franchise,
        productType: p.productType,
        availableStock: p.availableStock,
        isActive: true,
      })),
      events: {
        sales: sales.map((s): SaleEvent => ({
          productId: s.productId,
          qty: s.qty,
          lineTotal: s.total,
          at: toDate(s.at),
        })),
        wishlist: wishlist.map((w): WishlistEvent => ({
          productId: w.productId,
          at: toDate(w.at),
        })),
        cartAdds,
        views,
      },
    };
  }
}
