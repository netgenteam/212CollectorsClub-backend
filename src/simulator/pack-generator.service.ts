import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from '../tcg/tcg-api-client.interface.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import { defaultPokemonTemplate, type Template } from './simulator-defaults.js';
import {
  InsufficientCardsError,
  buildPool,
  drawPack,
  type PoolRow,
  type RandomInt,
} from './pack-draw.js';
import { SimulatorPoolCache, type CachedSet } from './pool-cache.js';

export interface PackCardDto {
  position: number;
  id: string;
  name: string;
  number: string | null;
  rarityTier: string;
  rarityRaw: string | null;
  isReverse: boolean;
  imageUrl: string | null;
  marketPriceUsd: number | null;
  product?: { slug: string; priceUsd: number };
}

export interface PackResponseDto {
  set: { setId: string; gameSlug: string; name: string };
  cards: PackCardDto[];
  totalValueUsd: number;
  pricedCards: number;
  unpricedCards: number;
}

const notFound = () =>
  new ApiException(
    HttpStatus.NOT_FOUND,
    'SIMULATOR_SET_NOT_FOUND',
    'Simulator set not found.',
  );

@Injectable()
export class PackGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SimulatorConfigService,
    private readonly cache: SimulatorPoolCache,
    @Inject(TCG_API_CLIENT) private readonly tcg: TcgApiClient,
  ) {}

  /** Cached per-set pool; ONE bounded query (only the 8 needed columns of ONE set). */
  private async loadSet(gameSlug: string, setId: string): Promise<CachedSet> {
    const key = `${gameSlug}:${setId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const cursor = await this.prisma.tcgIngestCursor.findFirst({
      where: { status: 'DONE', gameSlug, setId },
      select: { setName: true },
    });
    if (!cursor) throw notFound();
    const rows = await this.prisma.$queryRaw<PoolRow[]>(Prisma.sql`
      SELECT id::text AS id, name, "cardNumber", rarity, printing,
             "imageSmall", "imageLarge",
             round("marketPriceUsd" * 100)::int AS "priceCents"
      FROM "Master_Cards"
      WHERE "externalProvider" = ${this.tcg.provider}
        AND "gameSlug" = ${gameSlug} AND "setId" = ${setId}`);
    const value = {
      gameSlug,
      setId,
      setName: cursor.setName,
      pool: buildPool(rows),
    };
    this.cache.set(key, value);
    return this.cache.get(key) ?? { ...value, at: Date.now() };
  }

  async open(setId: string, rnd?: RandomInt): Promise<PackResponseDto> {
    const cfg = await this.config.getEffective();
    const entries = cfg.sets.filter((s) => s.setId === setId);
    if (entries.length === 0) throw notFound();
    let cached: CachedSet | undefined;
    let entry = entries[0];
    for (const e of entries) {
      try {
        cached = await this.loadSet(e.gameSlug, e.setId);
        entry = e;
        break;
      } catch (err) {
        if (!(err instanceof ApiException)) throw err;
      }
    }
    if (!cached) throw notFound();
    const template: Template | undefined =
      entry.template ??
      cfg.templates[entry.gameSlug] ??
      (entry.gameSlug === 'pokemon' ? defaultPokemonTemplate() : undefined);
    if (!template) throw notFound();

    let drawn;
    try {
      drawn = drawPack(cached.pool, template, rnd);
    } catch (err) {
      if (err instanceof InsufficientCardsError)
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'SIMULATOR_SET_INSUFFICIENT_CARDS',
          'This set does not have enough cards to open a pack.',
        );
      throw err;
    }

    const products = await this.findProducts(drawn.map((d) => d.card.id));
    let totalCents = 0;
    let priced = 0;
    const cards: PackCardDto[] = drawn.map(({ card, isReverse }, i) => {
      if (card.priceCents != null) {
        totalCents += card.priceCents;
        priced++;
      }
      const product = products.get(card.id);
      return {
        position: i + 1,
        id: card.id,
        name: card.name,
        number: card.number,
        rarityTier: card.tier,
        rarityRaw: card.rarityRaw,
        isReverse,
        imageUrl: card.imageUrl,
        marketPriceUsd: card.priceCents != null ? card.priceCents / 100 : null,
        ...(product ? { product } : {}),
      };
    });
    return {
      set: {
        setId,
        gameSlug: cached.gameSlug,
        name: entry.displayName ?? cached.setName,
      },
      cards,
      totalValueUsd: totalCents / 100,
      pricedCards: priced,
      unpricedCards: cards.length - priced,
    };
  }

  /** ONE query for all drawn cards (no N+1): cheapest active, in-stock product per card. */
  private async findProducts(
    ids: string[],
  ): Promise<Map<string, { slug: string; priceUsd: number }>> {
    const rows = await this.prisma.$queryRaw<
      { slug: string; priceUsd: Prisma.Decimal; masterCardId: string }[]
    >(Prisma.sql`
      SELECT DISTINCT ON ("masterCardId") slug, "priceUsd", "masterCardId"::text AS "masterCardId"
      FROM "Products"
      WHERE "masterCardId" = ANY(${ids}::uuid[])
        AND "isActive" AND stock - "heldQty" > 0
      ORDER BY "masterCardId", "priceUsd"`);
    return new Map(
      rows.map((r) => [
        r.masterCardId,
        { slug: r.slug, priceUsd: Number(r.priceUsd) },
      ]),
    );
  }
}
