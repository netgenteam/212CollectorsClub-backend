import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Order } from '../generated/prisma/client.js';
import type { OrderStatus, PaymentRail } from '../generated/prisma/enums.js';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto.js';
import { AdminOrderListItemDto } from './dto/admin-order-list-item.dto.js';
import {
  AdminOrdersPaginationMetaDto,
  PaginatedAdminOrdersResponseDto,
} from './dto/paginated-admin-orders-response.dto.js';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto.js';
import {
  AdminReconciliationResponseDto,
  ReconciliationBreakdownEntryDto,
  ReconciliationGrandTotalDto,
  ReconciliationRailTotalDto,
} from './dto/admin-reconciliation-response.dto.js';

/** Raw shape of one row from the `GROUP BY ROLLUP` query in
 * `getReconciliation` below — before it is split into `breakdown` /
 * `totalsByRail` / `grandTotal`. `paymentRail`/`status` come back as plain
 * uppercase text (cast in the SQL itself) so a `ROLLUP`-collapsed
 * dimension reads as a real SQL `NULL`, never an enum value that could be
 * confused with one; `orderCount`/`totalUsd`/`totalVes` are `unknown` here
 * for the same reason `CatalogService`'s own raw-query row interfaces are
 * (Story 2.2) — the pg driver returns `COUNT`/`SUM` as strings/bigint, not
 * native `number`, so every field is coerced explicitly below rather than
 * trusted as-is. */
interface ReconciliationRollupRow {
  paymentRail: string | null;
  status: string | null;
  orderCount: unknown;
  totalUsd: unknown;
  totalVes: unknown;
}

/**
 * Story 9.1 (FR-26, NFR-4; AD-11, AD-14). Read-only query over the
 * existing `Order` table (Epic 4/5) — no new tables, no schema changes
 * (this story's own Technical Notes). Lives in `OrdersModule` alongside
 * the buyer-facing `OrderLookupService`, per AD-14's explicit "one Orders
 * module, not a separate AdminOrders module" rule — see
 * `orders.module.ts`'s own doc comment for the wiring this requires.
 *
 * **Story 9.4 addition** (`getReconciliation`, FR-28, NFR-4): a note on
 * this story's own text before reading the method below. The story's
 * Architecture Decisions section claims AD-1 sanctions `$queryRaw`
 * "nowhere else in the codebase" besides this one aggregate. That is no
 * longer true and was likely already stale when this story was written —
 * `CatalogService.listProducts` (Story 2.2, pg_trgm search),
 * `CartService.updateItemQuantity` (Story 3.2/3.3, guarded stock UPDATE),
 * `AppService`'s health check, and `executeGuardedUpdate`
 * (`common/guarded-update.ts`, Story 4.1 — reused by 4.3/5.2/9.2/9.3) all
 * already use `$queryRaw`/`$executeRaw`. `ARCHITECTURE-SPINE.md`'s AD-1
 * text (`_bmad-output/.../ARCHITECTURE-SPINE.md`) is itself worded as "raw
 * `$queryRaw` is allowed only for the FR-28 reconciliation aggregate
 * view", so this drift predates this story and isn't something to fix
 * here — `getReconciliation` below still legitimately needs `$queryRaw`
 * (see its own doc comment for why), it just isn't uniquely-sanctioned
 * exception #1, it's simply another instance of the same
 * established-since-Story-2.2 pattern: Prisma's query builder only where
 * it expresses the query cleanly, parametrized raw SQL where it doesn't.
 *
 * Uses Prisma's typed query builder (`Prisma.OrderWhereInput`) rather than
 * `CatalogService.listProducts`'s hand-written raw SQL (Story 2.2): that
 * raw-SQL detour existed specifically so `search` could use the pg_trgm
 * `%` similarity operator, which Postgres has no query-builder-native way
 * to express. This story has no free-text search AC — every filter here
 * (`status`, `paymentRail`) is a plain equality match Prisma's own builder
 * already parametrizes safely — so the added complexity of raw SQL buys
 * nothing. The combinable-AND-filters-plus-pagination *shape* is still the
 * same pattern Story 2.2 established, just expressed through the
 * type-checked builder instead.
 */
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(
    query: ListAdminOrdersQueryDto,
  ): Promise<PaginatedAdminOrdersResponseDto> {
    const { page, limit, sortOrder } = query;
    const offset = (page - 1) * limit;

    // Story 9.1 AC2/AC3: `status`/`paymentRail` combine with AND semantics
    // (both added to the same `where`, never OR'd) — identical criterion to
    // Story 2.2's combinable catalog filters. Each wire value was already
    // validated against `AdminOrderStatusFilter`/`AdminOrderPaymentRailFilter`
    // by `ListAdminOrdersQueryDto`'s `@IsEnum` decorators (a stable 400 for
    // anything else, NFR-4) before this method ever runs — `.toUpperCase()`
    // is a safe plain string transform here only because every member of
    // those wire enums is spelled as the exact lowercase of its `OrderStatus`/
    // `PaymentRail` Prisma counterpart (see that DTO's own doc comment).
    const where: Prisma.OrderWhereInput = {};
    if (query.status) {
      where.status = query.status.toUpperCase() as OrderStatus;
    }
    if (query.paymentRail) {
      where.paymentRail = query.paymentRail.toUpperCase() as PaymentRail;
    }

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: offset,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const data: AdminOrderListItemDto[] = rows.map((order) =>
      this.toListItemDto(order),
    );

    const meta: AdminOrdersPaginationMetaDto = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };

    return { data, meta };
  }

  private toListItemDto(order: Order): AdminOrderListItemDto {
    return {
      orderId: order.id,
      status: order.status.toLowerCase(),
      paymentRail: order.paymentRail.toLowerCase(),
      fulfillmentType: order.fulfillmentType.toLowerCase(),
      recipientName: order.recipientName,
      totalUsd: Number(order.totalUsd),
      totalVes: order.totalVes !== null ? Number(order.totalVes) : null,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  /**
   * Story 9.4 (FR-28, NFR-4; AD-11, AD-14). Consolidated cross-rail payment
   * summary for `GET /api/v1/admin/orders/reconciliation?from=...&to=...`.
   * See this file's class-level doc comment above for why the story's own
   * "the one sanctioned $queryRaw exception" framing is stale — this method
   * still has a real, independent reason to use `$queryRaw` rather than
   * `prisma.order.groupBy`:
   *
   * A plain one-level `groupBy({ by: ['paymentRail', 'status'] })` IS
   * something Prisma's query builder can express — but this endpoint also
   * needs the per-rail subtotal (every status collapsed, one row per rail)
   * AND the overall grand total (both dimensions collapsed) in the SAME
   * response, which is exactly what makes this "at a glance" (AC1): an
   * admin should see "pago_movil totals" and "the whole period's total"
   * without doing the addition themselves. Prisma's query builder has no
   * `ROLLUP`/`GROUPING SETS` equivalent, so getting all three tiers
   * (group, rail-subtotal, grand-total) in one round trip needs
   * `GROUP BY ROLLUP("paymentRail", status)` — genuinely not expressible
   * through `groupBy()` without 3 separate queries (or summing groups in
   * JS, which is what this method deliberately avoids). `from`/`to` are
   * always bound as parameters via `Prisma.sql` (cast to `::timestamptz`)
   * — never string-interpolated — the same discipline
   * `CatalogService.listProducts` established in Story 2.2.
   *
   * Field choice: `orderCount` + `SUM(totalUsd)` + `SUM(totalVes)` per
   * (paymentRail, status) group. `totalUsd` is the one field every Order
   * always has (AD-3) — the natural "how much money" figure. `totalVes` is
   * included too (nullable — AD-3 never populates it for paypal Orders)
   * since VES is what a Pago Móvil buyer/admin actually reconciles against
   * a bank statement. Grouping by `status` (not just `paymentRail`) is the
   * actual reconciliation-relevant decision: it separates money genuinely
   * collected (`paid`/`fulfilled`) from money only ever attempted
   * (`payment_rejected`/`payment_failed`/`expired`) and from a `paid`
   * order later `cancelled` — collapsing straight to "total per rail"
   * would hide exactly the distinction a daily reconciliation workflow
   * (PRD UJ-5) needs. Filtered on `Order.createdAt` (Technical Notes:
   * aggregate over `Order`/`OrderLine` only, no new tables — there is no
   * separate "paid at" timestamp column to filter on instead; `createdAt`
   * is also what every other admin Order query in this module already
   * filters/sorts by, Story 9.1).
   *
   * A bare `to` date (no time component, e.g. `2026-09-30`) is treated as
   * the END of that day (23:59:59.999) rather than its literal UTC
   * midnight — otherwise a caller asking for "the month of September"
   * would silently lose all of Sep 30's Orders. A period with zero
   * matching Orders makes `GROUP BY ROLLUP` return zero rows (Postgres
   * never synthesizes a grand-total row over an empty input) — mapped
   * below to an explicit `{ breakdown: [], totalsByRail: [], grandTotal:
   * { orderCount: 0, totalUsd: 0, totalVes: null } }`, a valid empty
   * result (AC3), never an error.
   */
  async getReconciliation(
    query: ReconciliationQueryDto,
  ): Promise<AdminReconciliationResponseDto> {
    const fromDate = new Date(query.from);
    const toDate = new Date(query.to);
    // A bare date string (no "T") has no time component — treat `to` as
    // inclusive of the whole day it names.
    if (!query.to.includes('T')) {
      toDate.setUTCHours(23, 59, 59, 999);
    }

    const rows = await this.prisma.$queryRaw<ReconciliationRollupRow[]>(
      Prisma.sql`
        SELECT
          "paymentRail"::text AS "paymentRail",
          status::text AS "status",
          COUNT(*)::bigint AS "orderCount",
          SUM("totalUsd") AS "totalUsd",
          SUM("totalVes") AS "totalVes"
        FROM "Orders"
        WHERE "createdAt" >= ${fromDate}::timestamptz
          AND "createdAt" <= ${toDate}::timestamptz
        GROUP BY ROLLUP("paymentRail", "status")
        ORDER BY "paymentRail" ASC NULLS LAST, "status" ASC NULLS LAST
      `,
    );

    const breakdown: ReconciliationBreakdownEntryDto[] = [];
    const totalsByRail: ReconciliationRailTotalDto[] = [];
    let grandTotal: ReconciliationGrandTotalDto = {
      orderCount: 0,
      totalUsd: 0,
      totalVes: null,
    };

    for (const row of rows) {
      const orderCount = Number(row.orderCount);
      const totalUsd = Number(row.totalUsd ?? 0);
      const totalVes = row.totalVes === null ? null : Number(row.totalVes);

      if (row.paymentRail === null) {
        // Both dimensions collapsed by ROLLUP: the period's grand total.
        grandTotal = { orderCount, totalUsd, totalVes };
      } else if (row.status === null) {
        // Only `status` collapsed: the per-rail subtotal.
        totalsByRail.push({
          paymentRail: row.paymentRail.toLowerCase(),
          orderCount,
          totalUsd,
          totalVes,
        });
      } else {
        breakdown.push({
          paymentRail: row.paymentRail.toLowerCase(),
          status: row.status.toLowerCase(),
          orderCount,
          totalUsd,
          totalVes,
        });
      }
    }

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      breakdown,
      totalsByRail,
      grandTotal,
    };
  }
}
