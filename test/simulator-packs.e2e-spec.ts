import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from './../src/tcg/tcg-api-client.interface.js';
import { PackGeneratorService } from './../src/simulator/pack-generator.service.js';
import { SimulatorPoolCache } from './../src/simulator/pool-cache.js';
import { defaultPokemonTemplate } from './../src/simulator/simulator-defaults.js';

import { snapshotLanding, restoreLanding } from './helpers/db-snapshot.js';

type App = Parameters<typeof request>[0];
const P = 'e2e164-';
const BIG = `${P}big`;
const SMALL = `${P}small`;
const TINY = `${P}tiny`;
const PENDING = `${P}pending`;
const USER = 'e2e-admin-story-16-4';
const PASS = 'correct-horse-battery-staple-16-4';
const CFG = '/api/v1/admin/simulator/config';

interface PackBody {
  set: { setId: string; gameSlug: string; name: string };
  cards: {
    position: number;
    id: string;
    rarityTier: string;
    isReverse: boolean;
    imageUrl: string | null;
    marketPriceUsd: number | null;
    product?: { slug: string; priceUsd: number };
  }[];
  totalValueUsd: number;
  pricedCards: number;
  unpricedCards: number;
}
interface SetsBody {
  data: {
    setId: string;
    name: string;
    cardCount: number;
    imageUrl: string | null;
  }[];
}

/** Story 16.4 (AD-66/67). Real Postgres; fixtures prefixed `e2e164-` are removed at the end. */
describe('Simulator public sets and packs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: string;
  let token: string;
  let originalConfig: Awaited<ReturnType<typeof snapshotLanding>> = [];
  const CONFIG_ROW = { section: 'pack_simulator', key: 'config' };
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const clean = async () => {
    await prisma.product.deleteMany({ where: { slug: { startsWith: P } } });
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: P } },
    });
    await prisma.tcgIngestCursor.deleteMany({
      where: { setId: { startsWith: P } },
    });
  };

  const card = (
    set: string,
    n: number,
    rarity: string | null,
    over: Record<string, unknown> = {},
  ) => ({
    externalProvider: provider,
    externalId: `${P}${set}-${n}`,
    name: `E2E164 Card ${set} ${n}`,
    cleanName: `e2e164 card ${n}`,
    searchText: `e2e164 card ${n}`,
    franchise: 'POKEMON' as const,
    gameSlug: 'pokemon',
    setId: set,
    setName: `Set ${set}`,
    cardNumber: String(n),
    rarity,
    printing: 'Normal',
    imageSmall: `https://img.test/${set}-${n}-s.jpg`,
    imageLarge: n % 2 ? `https://img.test/${set}-${n}-l.jpg` : null,
    marketPriceUsd: n % 7 === 0 ? null : (n * 0.5).toString(),
    rawApiData: {},
    ...over,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    (app as unknown as NestExpressApplication).set('trust proxy', 1);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    provider = app.get<TcgApiClient>(TCG_API_CLIENT).provider;
    await clean();

    originalConfig = await snapshotLanding(prisma, CONFIG_ROW);

    const hash = await argon2.hash(PASS, { type: argon2.argon2id });
    await prisma.adminUser.upsert({
      where: { username: USER },
      create: {
        username: USER,
        email: `${USER}@212collectorsclub.test`,
        passwordHash: hash,
      },
      update: { passwordHash: hash },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    // BIG: 120 cards of varied rarity (some unpriced via n % 7).
    const rar = (n: number) =>
      n <= 40
        ? 'Common'
        : n <= 70
          ? 'Uncommon'
          : n <= 90
            ? 'Rare'
            : n <= 100
              ? 'Double Rare'
              : n <= 106
                ? 'Ultra Rare'
                : n <= 112
                  ? 'Illustration Rare'
                  : n <= 117
                    ? 'Special Illustration Rare'
                    : 'Hyper Rare';
    await prisma.masterCard.createMany({
      data: Array.from({ length: 120 }, (_, i) => card(BIG, i + 1, rar(i + 1))),
    });
    // SMALL: exactly 1 Common (unpriced) + 1 Rare, to check products/totals.
    await prisma.masterCard.createMany({
      data: [
        card(SMALL, 1, 'Common', { marketPriceUsd: null }),
        card(SMALL, 2, 'Rare', { marketPriceUsd: '12.34' }),
      ],
    });
    // TINY: 3 cards -> insufficient for the default template.
    await prisma.masterCard.createMany({
      data: [1, 2, 3].map((n) => card(TINY, n, 'Common')),
    });
    await prisma.masterCard.createMany({
      data: [card(PENDING, 1, 'Common')],
    });
    for (const [setId, status] of [
      [BIG, 'DONE'],
      [SMALL, 'DONE'],
      [TINY, 'DONE'],
      [PENDING, 'DONE'],
    ] as const)
      await prisma.tcgIngestCursor.create({
        data: { gameSlug: 'pokemon', setId, setName: `Set ${setId}`, status },
      });

    const smallTpl = {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 1 },
        { kind: 'rare', odds: { RARE: 100 } },
      ],
    };
    await request(app.getHttpServer())
      .put(CFG)
      .set(auth())
      .send({
        templates: { pokemon: defaultPokemonTemplate() },
        sets: [
          { gameSlug: 'pokemon', setId: BIG, displayName: 'E2E Big' },
          { gameSlug: 'pokemon', setId: SMALL, template: smallTpl },
          { gameSlug: 'pokemon', setId: TINY },
          { gameSlug: 'pokemon', setId: PENDING },
        ],
      })
      .expect(200);
    // PENDING stops being ingested after being enabled.
    await prisma.tcgIngestCursor.update({
      where: { gameSlug_setId: { gameSlug: 'pokemon', setId: PENDING } },
      data: { status: 'PENDING' },
    });
    app.get(SimulatorPoolCache).clear();
  });

  afterAll(async () => {
    await clean();
    await restoreLanding(prisma, CONFIG_ROW, originalConfig);
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  const open = (setId: unknown, ip = '198.51.100.1') =>
    request(app.getHttpServer())
      .post('/api/v1/simulator/packs')
      .set('X-Forwarded-For', ip)
      .send({ setId });

  it('GET /simulator/sets: only enabled + DONE sets, cache header, image of the priciest card', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/simulator/sets')
      .expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const data = (res.body as SetsBody).data.filter((s) =>
      s.setId.startsWith(P),
    );
    expect(data.map((s) => s.setId).sort()).toEqual([BIG, SMALL, TINY].sort());
    const big = data.find((s) => s.setId === BIG)!;
    expect(big).toMatchObject({ name: 'E2E Big', cardCount: 120 });
    // priciest card of BIG is #120 (even -> no imageLarge -> imageSmall)
    expect(big.imageUrl).toBe(`https://img.test/${BIG}-120-s.jpg`);
  });

  it('POST /simulator/packs validates setId (400)', async () => {
    await open('').expect(400);
    await open('has space').expect(400);
    await open('x'.repeat(65)).expect(400);
    await open(123).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/simulator/packs')
      .send({})
      .expect(400);
  });

  it('404 SIMULATOR_SET_NOT_FOUND is identical for unknown, not enabled and not-DONE sets', async () => {
    await prisma.tcgIngestCursor.upsert({
      where: { gameSlug_setId: { gameSlug: 'pokemon', setId: `${P}off` } },
      create: {
        gameSlug: 'pokemon',
        setId: `${P}off`,
        setName: 'x',
        status: 'DONE',
      },
      update: {},
    });
    const bodies = [];
    for (const id of [`${P}nope`, `${P}off`, PENDING]) {
      const r = await open(id).expect(404);
      bodies.push(r.body);
    }
    expect((bodies[0] as { errorCode: string }).errorCode).toBe(
      'SIMULATOR_SET_NOT_FOUND',
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('422 SIMULATOR_SET_INSUFFICIENT_CARDS for a set that cannot fill the template', async () => {
    const r = await open(TINY).expect(422);
    expect((r.body as { errorCode: string }).errorCode).toBe(
      'SIMULATOR_SET_INSUFFICIENT_CARDS',
    );
  });

  it('200 pack: shape, 10 distinct cards, rare last, value in cents, 0 TCG calls, nothing persisted, no N+1', async () => {
    const tcg = app.get<TcgApiClient>(TCG_API_CLIENT);
    const spies = (['listSets', 'listSetCards'] as const).map((m) =>
      vi.spyOn(tcg, m),
    );
    const [products0, orders0] = await Promise.all([
      prisma.product.count(),
      prisma.order.count(),
    ]);
    await open(BIG).expect(200); // warm pool cache
    const raw = vi.spyOn(prisma, '$queryRaw');
    const findCursor = vi.spyOn(prisma.tcgIngestCursor, 'findFirst');
    const res = await open(BIG).expect(200);
    // Warm cache: only the single products query; no cursor/pool queries.
    expect(raw).toHaveBeenCalledTimes(1);
    expect(findCursor).not.toHaveBeenCalled();
    raw.mockRestore();
    findCursor.mockRestore();

    const body = res.body as PackBody;
    expect(body.set).toEqual({
      setId: BIG,
      gameSlug: 'pokemon',
      name: 'E2E Big',
    });
    expect(body.cards).toHaveLength(10);
    expect(body.cards.map((c) => c.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(new Set(body.cards.map((c) => c.id)).size).toBe(10);
    expect([
      'RARE',
      'DOUBLE_RARE',
      'ULTRA_RARE',
      'ILLUSTRATION_RARE',
      'SPECIAL_ILLUSTRATION_RARE',
      'HYPER_RARE',
    ]).toContain(body.cards[9].rarityTier);
    expect(body.cards.slice(7, 9).every((c) => c.isReverse)).toBe(true);
    const cents = body.cards.reduce(
      (a, c) =>
        a + (c.marketPriceUsd == null ? 0 : Math.round(c.marketPriceUsd * 100)),
      0,
    );
    expect(body.totalValueUsd).toBe(cents / 100);
    expect(body.pricedCards + body.unpricedCards).toBe(10);
    expect(
      body.cards.every((c) => c.imageUrl?.startsWith('https://img.test/')),
    ).toBe(true);

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(await prisma.product.count()).toBe(products0);
    expect(await prisma.order.count()).toBe(orders0);
  });

  it('links only an active, in-stock Product (stock > heldQty), cheapest first; unpriced counts in unpricedCards', async () => {
    const category = await prisma.category.findFirstOrThrow();
    const cards = await prisma.masterCard.findMany({
      where: { setId: SMALL },
      orderBy: { cardNumber: 'asc' },
    });
    const mk = (
      slug: string,
      masterCardId: string,
      priceUsd: string,
      stock: number,
      heldQty: number,
      isActive = true,
    ) =>
      prisma.product.create({
        data: {
          name: slug,
          slug: `${P}${slug}`,
          description: 'd',
          franchise: 'POKEMON',
          productType: 'SINGLE_CARD',
          rarity: 'COMMON',
          priceUsd,
          stock,
          heldQty,
          isActive,
          masterCardId,
          categoryId: category.id,
        },
      });
    // Common: only fully-held and inactive products -> no link.
    await mk('c-held', cards[0].id, '1.00', 5, 5);
    await mk('c-inactive', cards[0].id, '1.00', 5, 0, false);
    // Rare: cheapest has no available stock, then two valid ones.
    await mk('r-cheap-nostock', cards[1].id, '2.00', 0, 0);
    await mk('r-mid', cards[1].id, '20.00', 3, 1);
    await mk('r-high', cards[1].id, '30.00', 9, 0);

    const res = await open(SMALL).expect(200);
    const body = res.body as PackBody;
    expect(body.cards).toHaveLength(2);
    expect(body.cards[0].product).toBeUndefined();
    expect(body.cards[1].rarityTier).toBe('RARE');
    expect(body.cards[1].product).toEqual({ slug: `${P}r-mid`, priceUsd: 20 });
    expect(body.totalValueUsd).toBe(12.34);
    expect(body.pricedCards).toBe(1);
    expect(body.unpricedCards).toBe(1);
  });

  it('p95 latency < 300 ms over 100 openings of a >= 100-card set', async () => {
    const gen = app.get(PackGeneratorService);
    await gen.open(BIG);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await gen.open(BIG);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[94]).toBeLessThan(300);
  });

  it('config save flushes the cache: saving the config clears the pool cache', async () => {
    const before = await request(app.getHttpServer())
      .get(CFG)
      .set(auth())
      .expect(200);
    const cfg = before.body as { sets: { setId: string }[] };
    cfg.sets = cfg.sets.filter((x) => x.setId !== PENDING); // not DONE: save would 422
    await request(app.getHttpServer())
      .put(CFG)
      .set(auth())
      .send(cfg)
      .expect(200);
    expect(app.get(SimulatorPoolCache).size()).toBe(0);
  });

  it('rejects __proto__/constructor/prototype game slugs with 400 over HTTP', async () => {
    for (const slug of ['__proto__', 'constructor', 'prototype']) {
      const tpl = JSON.stringify(defaultPokemonTemplate());
      const r = await request(app.getHttpServer())
        .put(CFG)
        .set(auth())
        .set('Content-Type', 'application/json')
        .send(`{"templates":{"${slug}":${tpl}},"sets":[]}`)
        .expect(400);
      expect((r.body as { errorCode: string }).errorCode).toBe(
        'SIMULATOR_CONFIG_INVALID',
      );
    }
  });

  it('rate limit: the 31st request in a minute from one IP is 429 with Retry-After; another IP is unaffected', async () => {
    const ip = '203.0.113.164';
    for (let i = 0; i < 30; i++) await open(BIG, ip).expect(200);
    const blocked = await open(BIG, ip).expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await open(BIG, '203.0.113.165').expect(200);
  });
});
