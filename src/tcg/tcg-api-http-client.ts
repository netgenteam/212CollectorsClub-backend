import { Logger } from '@nestjs/common';
import {
  TcgApiClient,
  TcgApiError,
  TcgApiRateLimitError,
  TcgCardDto,
  TcgPage,
  TcgSetContext,
  TcgSetDto,
} from './tcg-api-client.interface.js';
import {
  parseRateLimit,
  parseReset,
  toTcgCard,
  toTcgSet,
} from './tcg-card.normalizer.js';

export const TCGAPI_BASE_URL = 'https://api.tcgapi.dev/v1';
const PER_PAGE = 100;
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

interface TcgListBody {
  data?: unknown;
  meta?: {
    total?: number;
    page?: number;
    per_page?: number;
    has_more?: boolean;
  };
}

/**
 * Story 15.3 (AD-54): real tcgapi.dev client (native `fetch`). The key travels
 * only in `X-API-Key` and is redacted from every log line and thrown message.
 * 429 is never retried (throws `TcgApiRateLimitError`); 5xx / network /
 * timeout retry up to 3 attempts with exponential backoff, then `TcgApiError`.
 */
export class TcgApiHttpClient implements TcgApiClient {
  readonly provider = 'TCGAPI_DEV';
  private readonly logger = new Logger(TcgApiHttpClient.name);

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = TCGAPI_BASE_URL,
  ) {}

  async listSets(gameSlug: string, page: number): Promise<TcgPage<TcgSetDto>> {
    const { body, headers } = await this.get('/sets', {
      game: gameSlug,
      page: String(page),
      per_page: String(PER_PAGE),
    });
    return this.toPage(
      body,
      headers,
      page,
      this.items(body).map((r) => toTcgSet(r, gameSlug)),
    );
  }

  async listSetCards(
    setId: string,
    page: number,
    context: TcgSetContext = {},
  ): Promise<TcgPage<TcgCardDto>> {
    const { body, headers } = await this.get(
      `/sets/${encodeURIComponent(setId)}/cards`,
      { page: String(page), per_page: String(PER_PAGE) },
    );
    return this.toPage(
      body,
      headers,
      page,
      this.items(body).map((r) => toTcgCard(r, setId, context)),
    );
  }

  private items(body: TcgListBody): Array<Record<string, unknown>> {
    if (!Array.isArray(body.data)) {
      throw new TcgApiError('tcgapi.dev returned an unexpected body shape');
    }
    return body.data as Array<Record<string, unknown>>;
  }

  private toPage<T>(
    body: TcgListBody,
    headers: Headers,
    page: number,
    items: T[],
  ): TcgPage<T> {
    return {
      items,
      page: body.meta?.page ?? page,
      perPage: body.meta?.per_page ?? PER_PAGE,
      total: body.meta?.total ?? items.length,
      hasMore: body.meta?.has_more === true,
      rateLimit: parseRateLimit(headers),
    };
  }

  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
  }

  private async get(
    path: string,
    query: Record<string, string>,
  ): Promise<{ body: TcgListBody; headers: Headers }> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(query)}`;
    let lastMessage = 'unknown error';
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const retryAfterSec =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
          const resetAt =
            parseReset(res.headers.get('x-ratelimit-reset')) ??
            (retryAfterSec !== null
              ? new Date(Date.now() + retryAfterSec * 1000)
              : null);
          throw new TcgApiRateLimitError(resetAt, retryAfterSec);
        }
        if (res.status >= 500) {
          lastStatus = res.status;
          lastMessage = `HTTP ${res.status}`;
        } else if (!res.ok) {
          // 4xx other than 429: deterministic, not retried.
          throw new TcgApiError(
            this.redact(`tcgapi.dev request failed: HTTP ${res.status}`),
            res.status,
          );
        } else {
          return {
            body: (await res.json()) as TcgListBody,
            headers: res.headers,
          };
        }
      } catch (err) {
        if (err instanceof TcgApiRateLimitError || err instanceof TcgApiError) {
          throw err;
        }
        lastStatus = null;
        lastMessage = this.redact(
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        );
      }

      this.logger.warn(
        `tcgapi.dev ${path} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastMessage}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) =>
          setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)),
        );
      }
    }
    throw new TcgApiError(
      this.redact(
        `tcgapi.dev ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastMessage}`,
      ),
      lastStatus,
    );
  }
}
