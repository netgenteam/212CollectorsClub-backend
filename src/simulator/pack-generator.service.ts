import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Template } from './simulator-defaults.js';
import {
  InsufficientCardsError,
  drawPack,
  type RandomInt,
} from './pack-draw.js';
import { SimulatorPoolCache, type CachedSet } from './pool-cache.js';
import { buildPoolFromManual } from './manual/manual-pool.js';
import { MANUAL_GAME_SLUG } from './simulator-sets.service.js';
import { checkOddsSum, parseTemplate } from './simulator-config.validation.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Always null for manual sets (no Products link). */
  product: null;
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
  private readonly logger = new Logger(PackGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: SimulatorPoolCache,
  ) {}

  /** Cached pool keyed by `manual:<setId>:<version>`: a new version never reuses an old pool. */
  private async loadPool(
    setId: string,
    version: number,
  ): Promise<CachedSet['pool']> {
    const key = `manual:${setId}:${version}`;
    const hit = this.cache.get(key);
    if (hit) return hit.pool;
    const rows = await this.prisma.simulatorCard.findMany({
      where: { setId },
      select: {
        id: true,
        name: true,
        rarityTier: true,
        number: true,
        imageUrl: true,
        marketPriceUsd: true,
      },
    });
    const pool = buildPoolFromManual(rows);
    this.cache.set(key, {
      gameSlug: MANUAL_GAME_SLUG,
      setId,
      setName: '',
      pool,
    });
    return pool;
  }

  async open(setId: string, rnd?: RandomInt): Promise<PackResponseDto> {
    if (!UUID_RE.test(setId)) throw notFound();
    const set = await this.prisma.simulatorSet.findUnique({
      where: { id: setId },
      select: {
        isActive: true,
        version: true,
        name: true,
        template: true,
      },
    });
    if (!set || !set.isActive) throw notFound();
    let template: Template;
    try {
      template = parseTemplate(set.template, 'template');
      checkOddsSum(template, 'template');
    } catch (err) {
      if (!(err instanceof ApiException)) throw err;
      this.logger.error(`Manual set ${setId} has an invalid template`);
      throw notFound();
    }
    const pool = await this.loadPool(setId, set.version);

    let drawn;
    try {
      drawn = drawPack(pool, template, rnd);
    } catch (err) {
      if (err instanceof InsufficientCardsError) {
        // Broken invariant (A105): an active set must always be openable.
        this.logger.error(
          `Active manual set ${setId} (v${set.version}) cannot fill its template`,
        );
        throw notFound();
      }
      throw err;
    }

    let totalCents = 0;
    let priced = 0;
    const cards: PackCardDto[] = drawn.map(({ card, isReverse }, i) => {
      if (card.priceCents != null) {
        totalCents += card.priceCents;
        priced++;
      }
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
        product: null,
      };
    });
    return {
      set: { setId, gameSlug: MANUAL_GAME_SLUG, name: set.name },
      cards,
      totalValueUsd: totalCents / 100,
      pricedCards: priced,
      unpricedCards: cards.length - priced,
    };
  }
}
