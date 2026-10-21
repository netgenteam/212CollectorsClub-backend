import type {
  TcgCardDto,
  TcgRateLimit,
  TcgSetContext,
  TcgSetDto,
} from './tcg-api-client.interface.js';

type Raw = Record<string, unknown>;

/** Non-numeric or `<= 0` prices become null (A32: price "tal cual", never 0). */
export function toPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function int(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return value !== null && value !== '' && Number.isInteger(n) ? n : null;
}

/** The single normalizer of a tcgapi card JSON (AD-54). */
export function toTcgCard(
  raw: Raw,
  setId: string,
  context: TcgSetContext = {},
): TcgCardDto {
  const name = str(raw.name) ?? '';
  const rarity = str(raw.rarity);
  const productType = str(raw.product_type);
  return {
    externalId: String(raw.id),
    name,
    cleanName: str(raw.clean_name) ?? name.toLowerCase(),
    number: str(raw.number),
    rarity: rarity === null || rarity.toLowerCase() === 'none' ? null : rarity,
    productType,
    skip: productType !== 'Cards',
    tcgplayerId: int(raw.tcgplayer_id),
    printing: str(raw.printing),
    setId,
    setName: str(raw.set_name) ?? context.setName ?? null,
    gameSlug: str(raw.game_slug) ?? context.gameSlug ?? null,
    imageUrl: str(raw.image_url),
    marketPriceUsd: toPrice(raw.market_price),
    lowPriceUsd: toPrice(raw.low_price),
    medianPriceUsd: toPrice(raw.median_price),
    priceAsOf: str(raw.market_price_as_of),
    rawApiData: raw,
  };
}

export function toTcgSet(raw: Raw, gameSlugFallback: string): TcgSetDto {
  return {
    externalId: String(raw.id),
    name: str(raw.name) ?? '',
    slug: str(raw.slug),
    gameSlug: str(raw.game_slug) ?? gameSlugFallback,
    releaseDate: str(raw.release_date),
    cardCount: int(raw.card_count),
  };
}

/** Reset arrives as ISO-8601 (observed) or epoch seconds. */
export function parseReset(value: string | null): Date | null {
  if (!value) return null;
  const asNumber = Number(value);
  const date = Number.isFinite(asNumber)
    ? new Date(asNumber * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseRateLimit(headers: {
  get(name: string): string | null;
}): TcgRateLimit {
  const num = (name: string): number | null => {
    const v = headers.get(name);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    resetAt: parseReset(headers.get('x-ratelimit-reset')),
  };
}
