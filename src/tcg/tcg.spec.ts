import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { FakeTcgApiClient } from './fake-tcg-api-client.js';
import {
  TcgApiError,
  TcgApiRateLimitError,
} from './tcg-api-client.interface.js';
import { tcgApiClientProvider } from './tcg-api-client.provider.js';
import { TcgApiHttpClient } from './tcg-api-http-client.js';
import { toPrice, toTcgCard } from './tcg-card.normalizer.js';
import {
  FRANCHISE_BY_GAME,
  mapRarity,
  normalizeSearchText,
  slugify,
} from './tcg-mappings.js';

const KEY = 'test-secret-key-abc123XYZ';
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('tcg-mappings (Story 15.3, AC9)', () => {
  it('FRANCHISE_BY_GAME covers the script games', () => {
    expect(FRANCHISE_BY_GAME).toEqual({
      pokemon: 'POKEMON',
      'pokemon-japan': 'POKEMON',
      magic: 'MAGIC_THE_GATHERING',
      yugioh: 'YU_GI_OH',
      'one-piece-card-game': 'ONE_PIECE',
      'dragon-ball-super-ccg': 'DRAGON_BALL_SUPER',
      'dragon-ball-super-fusion-world': 'DRAGON_BALL_SUPER',
      naruto: 'NARUTO',
    });
  });

  it.each([
    ['Promo', 'PROMO'],
    ['Secret Rare', 'SECRET_RARE'],
    ['Special Illustration Rare', 'SECRET_RARE'],
    ['Hyper Rare', 'SECRET_RARE'],
    ['Ultra Rare', 'ULTRA_RARE'],
    ['Double Rare', 'ULTRA_RARE'],
    ['Rare Holo VMAX', 'ULTRA_RARE'],
    ['Super Rare', 'ULTRA_RARE'],
    ['Leader', 'ULTRA_RARE'],
    ['Uncommon', 'UNCOMMON'],
    ['Rare', 'RARE'],
    ['Rare Holo', 'RARE'],
    ['Common', 'COMMON'],
    ['C', 'COMMON'],
    ['', 'COMMON'],
  ])('mapRarity(%j) = %s', (raw, expected) => {
    expect(mapRarity(raw)).toBe(expected);
    expect(mapRarity(undefined)).toBe('COMMON');
  });

  it('slugify strips accents/symbols and trims dashes', () => {
    expect(slugify('Pokémon: Charizard ex (#006)!')).toBe(
      'pokemon-charizard-ex-006',
    );
    expect(slugify('---A  B---')).toBe('a-b');
  });

  it('normalizeSearchText: NFKD, no accents/symbols, lowercase', () => {
    expect(normalizeSearchText('  Pokémon  Évoli-EX #12/99 ')).toBe(
      'pokemon evoli ex 12 99',
    );
    expect(normalizeSearchText('Ｕｔａ (001)')).toBe('uta 001');
  });
});

describe('toTcgCard / toPrice (Story 15.3, AC6)', () => {
  it.each([
    [3.02, 3.02],
    ['0.15', 0.15],
    [0, null],
    [-1, null],
    ['abc', null],
    [null, null],
    [undefined, null],
    ['', null],
  ])('toPrice(%j) = %j', (v, expected) => {
    expect(toPrice(v)).toBe(expected);
  });

  it('normalizes the observed /sets/:id/cards items', () => {
    const body = fixture('tcgapi-set-cards.json') as {
      data: Array<Record<string, unknown>>;
    };
    const cards = body.data.map((r) =>
      toTcgCard(r, '1100100', {
        setName: 'ST-11: Starter Deck 11 Uta',
        gameSlug: 'one-piece-card-game',
      }),
    );
    const uta = cards.find((c) => c.externalId === '675181')!;
    expect(uta).toMatchObject({
      name: 'Uta (001)',
      cleanName: 'uta 001',
      number: 'ST11-001',
      rarity: 'L',
      tcgplayerId: 533879,
      printing: 'Foil',
      setId: '1100100',
      setName: 'ST-11: Starter Deck 11 Uta',
      gameSlug: 'one-piece-card-game',
      marketPriceUsd: 3.02,
      lowPriceUsd: 2,
      medianPriceUsd: 3.53,
      skip: false,
    });
    expect(uta.imageUrl).toContain('product-images.tcgplayer.com');
    const sealed = cards.find((c) => c.externalId === '675187')!;
    expect(sealed.skip).toBe(true);
    expect(sealed.marketPriceUsd).toBeNull();
    expect(sealed.rarity).toBeNull();
    expect(cards.filter((c) => !c.skip)).toHaveLength(5);
  });
});

describe('TcgApiHttpClient (mocked fetch, no network)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: MockInstance<(message: unknown) => void>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC6: listSetCards normalizes body, meta and rate-limit headers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(fixture('tcgapi-set-cards.json'), {
        headers: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '97',
          'x-ratelimit-reset': '2026-10-22T00:00:00.000Z',
        },
      }),
    );
    const client = new TcgApiHttpClient(KEY);
    const page = await client.listSetCards('1100100', 1, {
      setName: 'S',
      gameSlug: 'one-piece-card-game',
    });
    expect(page.items).toHaveLength(8);
    expect(page.total).toBe(8);
    expect(page.hasMore).toBe(false);
    expect(page.rateLimit).toEqual({
      limit: 100,
      remaining: 97,
      resetAt: new Date('2026-10-22T00:00:00.000Z'),
    });
    expect(page.items[0].externalId).toBe('675182');
    expect(typeof page.items[0].externalId).toBe('string');
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain('/sets/1100100/cards?');
    expect(url).toContain('per_page=100');
    expect(url).not.toContain(KEY);
    expect(init.headers['X-API-Key']).toBe(KEY);
  });

  it('listSets normalizes sets and has_more', async () => {
    const body = fixture('tcgapi-sets.json') as Record<string, unknown>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...body,
        meta: { total: 127, page: 1, per_page: 100, has_more: true },
      }),
    );
    const page = await new TcgApiHttpClient(KEY).listSets(
      'one-piece-card-game',
      1,
    );
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({
      externalId: expect.any(String) as string,
      gameSlug: 'one-piece-card-game',
      cardCount: expect.any(Number) as number,
    });
  });

  it('AC7: 429 throws TcgApiRateLimitError and is not retried', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'rate' },
        {
          status: 429,
          headers: {
            'retry-after': '120',
            'x-ratelimit-reset': '2026-10-22T00:00:00.000Z',
          },
        },
      ),
    );
    const err = await new TcgApiHttpClient(KEY)
      .listSetCards('1', 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TcgApiRateLimitError);
    expect((err as TcgApiRateLimitError).retryAfterSec).toBe(120);
    expect((err as TcgApiRateLimitError).resetAt).toEqual(
      new Date('2026-10-22T00:00:00.000Z'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC7: 500 retries 3 times with exponential backoff then TcgApiError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    const promise = new TcgApiHttpClient(KEY)
      .listSetCards('1', 1)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const err = await promise;
    expect(err).toBeInstanceOf(TcgApiError);
    expect((err as TcgApiError).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('AC7: network error / timeout recovers on a later attempt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockResolvedValueOnce(jsonResponse(fixture('tcgapi-set-cards.json')));
    const promise = new TcgApiHttpClient(KEY).listSetCards('1100100', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect((await promise).items).toHaveLength(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('other 4xx is not retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    await expect(
      new TcgApiHttpClient(KEY).listSetCards('1', 1),
    ).rejects.toBeInstanceOf(TcgApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC8: the key never appears in logs or thrown messages', async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    warn.mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    fetchMock.mockRejectedValue(
      new Error(`connect failed https://x/?key=${KEY} header ${KEY}`),
    );
    const promise = new TcgApiHttpClient(KEY)
      .listSetCards('1', 1)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = (await promise) as Error;
    expect(err).toBeInstanceOf(TcgApiError);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[REDACTED]');
    expect(logged.length).toBe(3);
    for (const line of logged) expect(line).not.toContain(KEY);
  });
});

describe('FakeTcgApiClient + provider (Story 15.3, AC5)', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (k: string) => values[k] }) as unknown as ConfigService;
  const factory = (
    tcgApiClientProvider as unknown as {
      useFactory: (c: ConfigService, f: FakeTcgApiClient) => unknown;
    }
  ).useFactory;

  it('without TCGAPI_KEY injects the fake and warns', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const fake = new FakeTcgApiClient();
    const client = factory(config({}), fake) as FakeTcgApiClient;
    expect(client).toBe(fake);
    expect(client.provider).toBe('FAKE');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('with TCGAPI_KEY injects the real client', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const client = factory(
      config({ TCGAPI_KEY: KEY }),
      new FakeTcgApiClient(),
    ) as TcgApiHttpClient;
    expect(client).toBeInstanceOf(TcgApiHttpClient);
    expect(client.provider).toBe('TCGAPI_DEV');
    log.mockRestore();
  });

  it('is deterministic with the same shape, a null price and a price hook', async () => {
    const a = new FakeTcgApiClient();
    const b = new FakeTcgApiClient();
    const sets = await a.listSets('pokemon', 1);
    expect(sets.items).toHaveLength(3);
    const setId = sets.items[0].externalId;
    const ctx = { setName: sets.items[0].name, gameSlug: 'pokemon' };
    const pa = await a.listSetCards(setId, 1, ctx);
    const pb = await b.listSetCards(setId, 1, ctx);
    expect(pa.items).toEqual(pb.items);
    expect(pa.items.some((c) => c.marketPriceUsd === null && !c.skip)).toBe(
      true,
    );
    expect(pa.items.some((c) => c.skip)).toBe(true);
    const card = pa.items.find((c) => c.marketPriceUsd !== null)!;
    a.setPrice(card.externalId, 99.5);
    const again = await a.listSetCards(setId, 1, ctx);
    expect(
      again.items.find((c) => c.externalId === card.externalId)!.marketPriceUsd,
    ).toBe(99.5);
    expect(pa.rateLimit.remaining).toBeLessThan(100);
  });

  it('simulated quota exhaustion throws TcgApiRateLimitError', async () => {
    const fake = new FakeTcgApiClient();
    fake.setQuota(0);
    await expect(fake.listSets('pokemon', 1)).rejects.toBeInstanceOf(
      TcgApiRateLimitError,
    );
  });
});
