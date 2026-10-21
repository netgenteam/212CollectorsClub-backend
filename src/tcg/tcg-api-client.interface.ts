/**
 * Story 15.3 (AD-54): the injectable seam every tcgapi.dev consumer
 * (ingestion 15.4, nightly sync 15.7) talks to. `TcgApiHttpClient` is the
 * real client; `FakeTcgApiClient` the deterministic double used when
 * `TCGAPI_KEY` is unset.
 */
export const TCG_API_CLIENT = Symbol('TCG_API_CLIENT');

export interface TcgRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

export interface TcgSetDto {
  externalId: string;
  name: string;
  slug: string | null;
  gameSlug: string;
  /** `YYYY-MM-DD` or null. */
  releaseDate: string | null;
  cardCount: number | null;
}

export interface TcgCardDto {
  externalId: string;
  name: string;
  cleanName: string;
  number: string | null;
  /** Raw API rarity; the placeholder "None" (sealed products) becomes null. */
  rarity: string | null;
  productType: string | null;
  /** true when `product_type !== 'Cards'` (sealed etc.): ingestion skips it. */
  skip: boolean;
  tcgplayerId: number | null;
  printing: string | null;
  setId: string;
  setName: string | null;
  gameSlug: string | null;
  imageUrl: string | null;
  marketPriceUsd: number | null;
  lowPriceUsd: number | null;
  medianPriceUsd: number | null;
  /** `YYYY-MM-DD` or null (`market_price_as_of`). */
  priceAsOf: string | null;
  rawApiData: Record<string, unknown>;
}

export interface TcgPage<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
  rateLimit: TcgRateLimit;
}

/**
 * `/sets/:id/cards` items do NOT carry set_name/game_slug (observed in Story
 * 15.3), so the caller (who knows the set from `listSets`) passes them.
 */
export interface TcgSetContext {
  setName?: string | null;
  gameSlug?: string | null;
}

export interface TcgApiClient {
  readonly provider: string;
  listSets(gameSlug: string, page: number): Promise<TcgPage<TcgSetDto>>;
  listSetCards(
    setId: string,
    page: number,
    context?: TcgSetContext,
  ): Promise<TcgPage<TcgCardDto>>;
}

/** HTTP 429: never retried; the caller must stop its batch. */
export class TcgApiRateLimitError extends Error {
  constructor(
    readonly resetAt: Date | null,
    readonly retryAfterSec: number | null,
  ) {
    super('tcgapi.dev rate limit exceeded (HTTP 429)');
    this.name = 'TcgApiRateLimitError';
  }
}

export class TcgApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'TcgApiError';
  }
}
