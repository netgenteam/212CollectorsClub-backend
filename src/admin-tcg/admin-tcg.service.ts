import { Injectable } from '@nestjs/common';
import { buildPageMeta } from '../common/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeSearchText } from '../tcg/tcg-mappings.js';
import type { MasterCardSearchResponseDto } from './dto/master-card-search-response.dto.js';
import type { SearchMasterCardsQueryDto } from './dto/search-master-cards-query.dto.js';

/**
 * Story 15.5 (FR-68, AD-56). Local-DB-only search over `MasterCard` (never
 * calls tcgapi). One row per printing; `marketPriceUsd` may be null.
 */
@Injectable()
export class AdminTcgService {
  constructor(private readonly prisma: PrismaService) {}

  async searchMasterCards(
    query: Readonly<SearchMasterCardsQueryDto>,
  ): Promise<MasterCardSearchResponseDto> {
    const { page, limit, franchise } = query;
    const tokens = normalizeSearchText(query.q ?? '')
      .split(' ')
      .filter(Boolean);
    const rawSet = query.set?.trim();
    // ILIKE wildcards in the user's `set` must match literally.
    const escapedSet = rawSet?.replace(/[\\%_]/g, '\\$&');

    const and: Prisma.MasterCardWhereInput[] = tokens.map((t) => ({
      searchText: { contains: t },
    }));
    if (rawSet && escapedSet) {
      and.push({
        OR: [
          { setId: rawSet },
          { setName: { contains: escapedSet, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.MasterCardWhereInput = {
      ...(franchise ? { franchise } : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const [total, cards] = await Promise.all([
      this.prisma.masterCard.count({ where }),
      this.prisma.masterCard.findMany({
        where,
        orderBy: [
          { marketPriceUsd: { sort: 'desc', nulls: 'last' } },
          { name: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // A34: a single aggregate for the whole page (no N+1); includes inactive
    // products and raw stock.
    const inventory = cards.length
      ? await this.prisma.product.groupBy({
          by: ['masterCardId'],
          where: { masterCardId: { in: cards.map((c) => c.id) } },
          _count: { _all: true },
          _sum: { stock: true },
        })
      : [];
    const byCard = new Map(
      inventory.map((g) => [
        g.masterCardId,
        { count: g._count._all, stock: g._sum.stock ?? 0 },
      ]),
    );

    return {
      data: cards.map((c) => {
        const inv = byCard.get(c.id);
        return {
          id: c.id,
          externalId: c.externalId,
          name: c.name,
          franchise: c.franchise,
          setId: c.setId,
          setName: c.setName,
          cardNumber: c.cardNumber,
          rarity: c.rarity,
          printing: c.printing,
          editionLanguage: c.editionLanguage,
          imageSmall: c.imageSmall,
          imageLarge: c.imageLarge,
          apiPriceUsd:
            c.marketPriceUsd === null ? null : Number(c.marketPriceUsd),
          alreadyInInventory: (inv?.count ?? 0) > 0,
          currentInventoryStock: inv?.stock ?? 0,
        };
      }),
      meta: buildPageMeta(page, limit, total),
    };
  }
}
