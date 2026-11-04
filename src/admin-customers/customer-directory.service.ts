import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { stripIdDocFromName } from '../crypto/id-doc-in-name.js';
import { IdDocCryptoService } from '../crypto/id-doc-crypto.service.js';
import { toAddressResponse } from '../customer-addresses/customer-addresses.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import { AdminOrdersService } from '../orders/admin-orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AdminCustomerDetailDto,
  AdminCustomerListResponseDto,
} from './dto/admin-customer-response.dto.js';
import type { SearchCustomersDto } from './dto/search-customers.dto.js';
import {
  ACTIVE_ORDER_STATUSES,
  ANONYMIZE_NOTICES,
  MAX_ACTIVE_ORDERS_LISTED,
} from './customer-anonymization.service.js';

export const CUSTOMERS_PAGE_SIZE = 50;
const RECENT_ORDERS = 10;
export const MAX_IDDOC_MATCHES = 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escapes the LIKE metacharacters (`\`, `%`, `_`) so the text is matched literally. */
export const escapeLike = (text: string): string =>
  text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const cursorInvalid = (): ApiException =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    'CURSOR_INVALID',
    'The cursor is not valid. Start again from the first page.',
  );

/** Keyset cursor (createdAt desc, id desc): opaque base64url of `{c, i}`. */
export function encodeCustomerCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ c: createdAt.toISOString(), i: id }),
  ).toString('base64url');
}

export function decodeCustomerCursor(raw: string): { c: Date; i: string } {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw cursorInvalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursorInvalid();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { c?: unknown }).c !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw cursorInvalid();
  }
  const { c, i } = parsed as { c: string; i: string };
  const date = new Date(c);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== c ||
    !UUID_RE.test(i)
  ) {
    throw cursorInvalid();
  }
  return { c: date, i: i.toLowerCase() };
}

/**
 * Story 20.6 (AC8): the admin's view of the customer accounts. Search by partial email/name and by
 * EXACT cedula (blind index) - both in a POST body, never in a URL (FR-124) - and the detail with
 * the real numbers the "delete account" warning needs (`anonymization`). No cedula in clear
 * anywhere: addresses go through the single masking serializer.
 */
@Injectable()
export class CustomerDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idDocCrypto: IdDocCryptoService,
    private readonly adminOrders: AdminOrdersService,
  ) {}

  /** `cursor` only (the GET list): newest first. Same shape as the search. */
  list(cursor?: string): Promise<AdminCustomerListResponseDto> {
    return this.search({ cursor });
  }

  async search(
    dto: Pick<SearchCustomersDto, 'q' | 'idDoc' | 'cursor'>,
  ): Promise<AdminCustomerListResponseDto> {
    const and: Prisma.CustomerWhereInput[] = [];

    // Validated BEFORE any query (400 ID_DOC_FILTER_INVALID, the value is never echoed).
    if (dto.idDoc !== undefined) {
      const blind = this.adminOrders.idDocBlindOrThrow(dto.idDoc);
      // Resolved by the three blind indexes first (index scans; a `WHERE EXISTS(...) OR EXISTS(...)`
      // on Customers would scan the whole table). A cedula shared by more than MAX_IDDOC_MATCHES
      // accounts is not a person: the list is cut (and says so by being full).
      const found = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "customerId"::text AS "id" FROM "Orders"
         WHERE "recipientIdDocBlind" = ${blind} AND "customerId" IS NOT NULL
        UNION
        SELECT "customerId"::text FROM "Orders"
         WHERE "buyerIdDocBlind" = ${blind} AND "customerId" IS NOT NULL
        UNION
        SELECT "customerId"::text FROM "Customer_Addresses"
         WHERE "recipientIdDocBlind" = ${blind}
        LIMIT ${MAX_IDDOC_MATCHES}`;
      and.push({ id: { in: found.map((r) => r.id) } });
    }
    if (dto.q !== undefined) {
      // `q` is text to FIND, never a LIKE pattern: Prisma does not escape `%` and `_` in `contains`,
      // so `%%` or `__` would match every customer. `\` is Postgres' default LIKE escape.
      const q = escapeLike(dto.q.normalize('NFKC').trim());
      and.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (dto.cursor !== undefined) {
      const { c, i } = decodeCustomerCursor(dto.cursor);
      and.push({
        OR: [{ createdAt: { lt: c } }, { createdAt: c, id: { lt: i } }],
      });
    }

    const rows = await this.prisma.customer.findMany({
      where: and.length > 0 ? { AND: and } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CUSTOMERS_PAGE_SIZE + 1,
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        createdAt: true,
        anonymizedAt: true,
      },
    });
    const hasNextPage = rows.length > CUSTOMERS_PAGE_SIZE;
    const page = hasNextPage ? rows.slice(0, CUSTOMERS_PAGE_SIZE) : rows;

    const counts = new Map<string, { total: number; active: number }>();
    if (page.length > 0) {
      const grouped = await this.prisma.order.groupBy({
        by: ['customerId', 'status'],
        where: { customerId: { in: page.map((c) => c.id) } },
        _count: { _all: true },
      });
      for (const g of grouped) {
        if (!g.customerId) continue;
        const e = counts.get(g.customerId) ?? { total: 0, active: 0 };
        e.total += g._count._all;
        if (
          (ACTIVE_ORDER_STATUSES as readonly OrderStatus[]).includes(g.status)
        ) {
          e.active += g._count._all;
        }
        counts.set(g.customerId, e);
      }
    }

    const last = page[page.length - 1];
    return {
      data: page.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        emailVerified: c.emailVerified,
        createdAt: c.createdAt.toISOString(),
        anonymizedAt: c.anonymizedAt ? c.anonymizedAt.toISOString() : null,
        ordersCount: counts.get(c.id)?.total ?? 0,
        activeOrdersCount: counts.get(c.id)?.active ?? 0,
      })),
      meta: {
        limit: CUSTOMERS_PAGE_SIZE,
        hasNextPage,
        nextCursor:
          hasNextPage && last
            ? encodeCustomerCursor(last.createdAt, last.id)
            : null,
      },
    };
  }

  async detail(customerId: string): Promise<AdminCustomerDetailDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CUSTOMER_NOT_FOUND',
        'Customer not found.',
      );
    }
    const activeWhere = {
      customerId,
      status: { in: [...ACTIVE_ORDER_STATUSES] },
    };
    const [
      addresses,
      recent,
      byStatus,
      activeItems,
      sessions,
      credentials,
      verifications,
      carts,
      wishlists,
      consents,
      inquiries,
      refundPending,
    ] = await Promise.all([
      this.prisma.customerAddress.findMany({
        where: { customerId },
        include: {
          agency: {
            select: {
              id: true,
              name: true,
              code: true,
              isActive: true,
              allowsOfficePickup: true,
              allowsHomeDelivery: true,
            },
          },
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.order.findMany({
        where: { customerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_ORDERS,
        select: {
          id: true,
          status: true,
          paymentRail: true,
          totalUsd: true,
          createdAt: true,
        },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { customerId },
        _count: { _all: true },
      }),
      this.prisma.order.findMany({
        where: activeWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_ACTIVE_ORDERS_LISTED,
        select: { id: true, status: true, createdAt: true },
      }),
      this.prisma.customerSession.count({ where: { userId: customerId } }),
      this.prisma.customerAccount.count({ where: { userId: customerId } }),
      this.prisma.customerVerification.count({
        where: {
          OR: [{ identifier: customer.email }, { value: customerId }],
        },
      }),
      this.prisma.cart.count({ where: { customerId } }),
      this.prisma.wishlist.count({ where: { customerId } }),
      this.prisma.consentRecord.count({ where: { customerId } }),
      this.prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS "n" FROM "Contact_Inquiries" WHERE lower("email") = lower(${customer.email})`,
      // Orders of this account (any status) with a `refund_pending_*` Stripe outcome: the money is
      // still owed and the orders stay after the anonymization (Story 20.6, QA round 2).
      this.prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(DISTINCT e."orderId") AS "n" FROM "Stripe_Webhook_Events" e
          JOIN "Orders" o ON o."id" = e."orderId"
         WHERE o."customerId" = ${customerId}::uuid AND starts_with(e."outcome", 'refund_pending_')`,
    ]);
    const inquiriesKept = Number(inquiries[0]?.n ?? 0);
    const ordersRefundPending = Number(refundPending[0]?.n ?? 0);

    let ordersTotal = 0;
    let activeCount = 0;
    for (const g of byStatus) {
      ordersTotal += g._count._all;
      if (
        (ACTIVE_ORDER_STATUSES as readonly OrderStatus[]).includes(g.status)
      ) {
        activeCount += g._count._all;
      }
    }
    const anonymized = customer.anonymizedAt !== null;

    return {
      id: customer.id,
      email: customer.email,
      name: stripIdDocFromName(customer.name),
      phone: customer.phone,
      emailVerified: customer.emailVerified,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
      anonymizedAt: customer.anonymizedAt
        ? customer.anonymizedAt.toISOString()
        : null,
      anonymizedById: customer.anonymizedById,
      addresses: addresses.map((a) => toAddressResponse(a, this.idDocCrypto)),
      recentOrders: recent.map((o) => ({
        id: o.id,
        status: o.status.toLowerCase(),
        paymentRail: o.paymentRail.toLowerCase(),
        totalUsd: Number(o.totalUsd),
        createdAt: o.createdAt.toISOString(),
      })),
      anonymization: {
        canAnonymize: !anonymized && activeCount === 0,
        activeOrders: {
          count: activeCount,
          items: activeItems.map((o) => ({
            id: o.id,
            status: o.status.toLowerCase(),
            createdAt: o.createdAt.toISOString(),
          })),
        },
        willDelete: {
          addresses: addresses.length,
          sessions,
          credentials,
          verificationTokens: verifications,
          carts,
          wishlists,
        },
        willKeep: {
          orders: ordersTotal,
          consentRecords: consents,
          contactInquiries: inquiriesKept,
          ordersWithRefundPending: ordersRefundPending,
        },
        notices: [
          'NOT_RECOMMENDED_ONLY_ON_EXPLICIT_REQUEST_OF_THE_OWNER',
          'IRREVERSIBLE',
          'ORDERS_AND_FISCAL_ID_KEPT',
          ...(ordersRefundPending > 0 ? ['REFUND_PENDING_ON_KEPT_ORDERS'] : []),
          ...(inquiriesKept > 0
            ? ['CONTACT_MESSAGES_KEPT_UNTIL_RETENTION']
            : []),
          ...ANONYMIZE_NOTICES,
        ],
      },
    };
  }
}
