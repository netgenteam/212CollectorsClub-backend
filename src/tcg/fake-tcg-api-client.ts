import { Injectable, Logger } from '@nestjs/common';
import {
  TcgApiClient,
  TcgApiRateLimitError,
  TcgCardDto,
  TcgPage,
  TcgRateLimit,
  TcgSetContext,
  TcgSetDto,
} from './tcg-api-client.interface.js';
import { toTcgCard } from './tcg-card.normalizer.js';

const SETS_PER_GAME = 3;
const CARDS_PER_SET = 12;
const FAKE_PAGE_SIZE = 100;
const FAKE_DAILY_LIMIT = 100;

function gameIndex(gameSlug: string): number {
  let h = 0;
  for (const ch of gameSlug) h = (h * 31 + ch.charCodeAt(0)) % 900;
  return h + 1;
}

/**
 * Story 15.3 (AD-54): deterministic in-memory `TcgApiClient`, no network.
 * Same shape as the real client (cards are built through the same
 * `toTcgCard` normalizer from tcgapi-shaped JSON). Per game: 3 sets of 12
 * cards; card #12 is sealed (`skip`), card #11 has no price, the rest have
 * a price derived from their id. `setPrice()` overrides a price and
 * `setQuota()` configures the simulated daily quota (0 => 429 error).
 */
@Injectable()
export class FakeTcgApiClient implements TcgApiClient {
  readonly provider = 'FAKE';
  private readonly logger = new Logger(FakeTcgApiClient.name);
  private readonly priceOverrides = new Map<string, number | null>();
  private remaining = FAKE_DAILY_LIMIT;
  /** Every call made, for assertions: `listSets:<game>:<page>` etc. */
  readonly calls: string[] = [];

  /** Settable price hook: `null` makes the card priceless. */
  setPrice(externalId: string, price: number | null): void {
    this.priceOverrides.set(externalId, price);
  }

  setQuota(remaining: number): void {
    this.remaining = remaining;
  }

  reset(): void {
    this.priceOverrides.clear();
    this.calls.length = 0;
    this.remaining = FAKE_DAILY_LIMIT;
  }

  static setIdFor(gameSlug: string, n: number): string {
    return String(gameIndex(gameSlug) * 100 + n);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSets(gameSlug: string, page: number): Promise<TcgPage<TcgSetDto>> {
    this.calls.push(`listSets:${gameSlug}:${page}`);
    const rateLimit = this.consume();
    const items: TcgSetDto[] =
      page === 1
        ? Array.from({ length: SETS_PER_GAME }, (_, i) => ({
            externalId: FakeTcgApiClient.setIdFor(gameSlug, i + 1),
            name: `Fake ${gameSlug} Set ${i + 1}`,
            slug: `fake-${gameSlug}-set-${i + 1}`,
            gameSlug,
            releaseDate: `2026-0${i + 1}-15`,
            cardCount: CARDS_PER_SET,
          }))
        : [];
    return {
      items,
      page,
      perPage: FAKE_PAGE_SIZE,
      total: SETS_PER_GAME,
      hasMore: false,
      rateLimit,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSetCards(
    setId: string,
    page: number,
    context: TcgSetContext = {},
  ): Promise<TcgPage<TcgCardDto>> {
    this.calls.push(`listSetCards:${setId}:${page}`);
    const rateLimit = this.consume();
    const items =
      page === 1
        ? Array.from({ length: CARDS_PER_SET }, (_, i) =>
            this.buildCard(setId, i + 1, context),
          )
        : [];
    return {
      items,
      page,
      perPage: FAKE_PAGE_SIZE,
      total: CARDS_PER_SET,
      hasMore: false,
      rateLimit,
    };
  }

  private buildCard(
    setId: string,
    n: number,
    context: TcgSetContext,
  ): TcgCardDto {
    const id = Number(setId) * 100 + n;
    const sealed = n === CARDS_PER_SET;
    const noPrice = n === CARDS_PER_SET - 1;
    const externalId = String(id);
    const base = ((id % 97) + 1) / 4;
    const price = this.priceOverrides.has(externalId)
      ? this.priceOverrides.get(externalId)!
      : noPrice
        ? null
        : base;
    const raw: Record<string, unknown> = {
      id,
      name: sealed ? `Fake Booster Box ${setId}` : `Fake Card ${setId}-${n}`,
      clean_name: sealed
        ? `fake booster box ${setId}`
        : `fake card ${setId} ${n}`,
      number: sealed ? null : `FAKE-${String(n).padStart(3, '0')}`,
      rarity: sealed ? 'None' : ['C', 'U', 'R', 'SR'][n % 4],
      tcgplayer_id: 900000 + id,
      product_type: sealed ? 'Sealed Products' : 'Cards',
      printing: n % 2 === 0 ? 'Foil' : 'Normal',
      market_price: price,
      market_price_as_of: price === null ? null : '2026-10-21',
      low_price: price === null ? null : Math.round(price * 80) / 100,
      median_price: price === null ? null : Math.round(price * 110) / 100,
      image_url: `https://product-images.tcgplayer.com/fit-in/400x400/${900000 + id}.jpg`,
    };
    return toTcgCard(raw, setId, {
      setName: context.setName ?? `Fake Set ${setId}`,
      gameSlug: context.gameSlug ?? null,
    });
  }

  private consume(): TcgRateLimit {
    const resetAt = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate() + 1,
      ),
    );
    if (this.remaining <= 0) {
      this.logger.warn('[FAKE] simulated quota exhausted');
      throw new TcgApiRateLimitError(resetAt, null);
    }
    this.remaining -= 1;
    return { limit: FAKE_DAILY_LIMIT, remaining: this.remaining, resetAt };
  }
}
