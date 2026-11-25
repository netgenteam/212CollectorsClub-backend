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
import { ApiException } from './../src/common/api-exception.js';
import { PackGeneratorService } from './../src/simulator/pack-generator.service.js';
import { SimulatorPoolCache } from './../src/simulator/pool-cache.js';
import { defaultPokemonTemplate } from './../src/simulator/simulator-defaults.js';
import { snapshotLanding, restoreLanding } from './helpers/db-snapshot.js';
import {
  BIG_TIERS,
  MIN_TIERS,
  cleanManualSets,
  seedManualSet,
} from './helpers/simulator-seed.js';

type App = Parameters<typeof request>[0];
const P = 'E2E228 ';
const USER = 'e2e-admin-story-22-8';
const PASS = 'correct-horse-battery-staple-22-8';
const CFG = '/api/v1/admin/simulator/config';
const MANUAL = '/api/v1/admin/simulator/manual-sets';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const RARE_TIERS = [
  'RARE',
  'DOUBLE_RARE',
  'ULTRA_RARE',
  'ILLUSTRATION_RARE',
  'SPECIAL_ILLUSTRATION_RARE',
  'HYPER_RARE',
];

interface PackBody {
  set: { setId: string; gameSlug: string; name: string };
  cards: {
    position: number;
    id: string;
    name: string;
    number: string | null;
    rarityTier: string;
    rarityRaw: string | null;
    isReverse: boolean;
    imageUrl: string | null;
    marketPriceUsd: number | null;
    product: null;
  }[];
  totalValueUsd: number;
  pricedCards: number;
  unpricedCards: number;
}
interface SetsBody {
  data: {
    setId: string;
    gameSlug: string;
    name: string;
    cardCount: number;
    imageUrl: string | null;
  }[];
}
interface Err {
  errorCode?: string;
  message?: unknown;
}

/**
 * Story 22.8 (AD-108, FR-154/157): public simulator over ACTIVE + READY manual sets. Sets are
 * seeded by Prisma (prefix `E2E228 `) and removed at the end; the legacy config row is restored.
 */
describe('Simulator public sets and packs over manual sets (e2e, Story 22.8)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let big: { id: string; cardIds: string[] };
  let min: { id: string; cardIds: string[] };
  let inactive: { id: string };
  let notReady: { id: string };
  let originalConfig: Awaited<ReturnType<typeof snapshotLanding>> = [];
  const CONFIG_ROW = { section: 'pack_simulator', key: 'config' };
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const cache = () => app.get(SimulatorPoolCache);

  // A distinct default IP per call keeps this suite far from the per-IP rate limit.
  let ipSeq = 0;
  const open = (setId: unknown, ip = `198.51.100.${(ipSeq++ % 250) + 1}`) =>
    server()
      .post('/api/v1/simulator/packs')
      .set('X-Forwarded-For', ip)
      .send({ setId });
  const list = async () =>
    (await server().get('/api/v1/simulator/sets').expect(200)).body as SetsBody;
  const mine = (b: SetsBody) =>
    b.data.filter((s) => s.name.startsWith(P)).map((s) => s.name);

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
    await cleanManualSets(prisma, P);
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
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    big = await seedManualSet(prisma, {
      name: `${P}Big`,
      tiers: BIG_TIERS,
      imageUrl: '/uploads/public/simulator/big.png',
    });
    min = await seedManualSet(prisma, { name: `${P}Min`, tiers: MIN_TIERS });
    inactive = await seedManualSet(prisma, {
      name: `${P}Inactive`,
      tiers: BIG_TIERS,
      isActive: false,
    });
    // Active but NOT ready (invariant broken "by manual SQL"): 3 commons only.
    notReady = await seedManualSet(prisma, {
      name: `${P}NotReady`,
      tiers: { COMMON: 3 },
    });
    cache().clear();
  });

  afterAll(async () => {
    await cleanManualSets(prisma, P);
    await restoreLanding(prisma, CONFIG_ROW, originalConfig);
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  it('GET /simulator/sets: only active AND ready sets, same shape, cache header', async () => {
    const res = await server().get('/api/v1/simulator/sets').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.body as SetsBody;
    expect(mine(body).sort()).toEqual([`${P}Big`, `${P}Min`]);
    const b = body.data.find((s) => s.setId === big.id)!;
    expect(Object.keys(b).sort()).toEqual([
      'cardCount',
      'gameSlug',
      'imageUrl',
      'name',
      'setId',
    ]);
    expect(b).toEqual({
      setId: big.id,
      gameSlug: 'pokemon',
      name: `${P}Big`,
      cardCount: 120,
      imageUrl: '/uploads/public/simulator/big.png',
    });
    expect(body.data.find((s) => s.setId === min.id)).toMatchObject({
      cardCount: 15,
      imageUrl: null,
    });
  });

  it('list uses ONE aggregated count query for all active sets (no per-set queries)', async () => {
    cache().clear();
    const raw = vi.spyOn(prisma, '$queryRaw');
    const sets = vi.spyOn(prisma.simulatorSet, 'findMany');
    const cards = vi.spyOn(prisma.simulatorCard, 'findMany');
    await list();
    await list(); // 60 s cache
    expect(raw).toHaveBeenCalledTimes(1);
    expect(sets).toHaveBeenCalledTimes(1);
    expect(cards).not.toHaveBeenCalled();
    raw.mockRestore();
    sets.mockRestore();
    cards.mockRestore();
  });

  it('admin writes are visible on the very next request (no TTL wait): deactivate / activate / edit / delete', async () => {
    const extra = await seedManualSet(prisma, {
      name: `${P}Extra`,
      tiers: MIN_TIERS,
      isActive: false,
    });
    await list(); // warm the 60 s cache
    expect(mine(await list())).not.toContain(`${P}Extra`);
    await server()
      .patch(`${MANUAL}/${extra.id}`)
      .set(auth())
      .send({ isActive: true })
      .expect(200);
    expect(mine(await list())).toContain(`${P}Extra`);
    await open(extra.id).expect(200);
    await server()
      .patch(`${MANUAL}/${extra.id}`)
      .set(auth())
      .send({ name: `${P}Extra renamed` })
      .expect(200);
    expect(mine(await list())).toContain(`${P}Extra renamed`);
    expect(((await open(extra.id).expect(200)).body as PackBody).set.name).toBe(
      `${P}Extra renamed`,
    );
    await server()
      .patch(`${MANUAL}/${extra.id}`)
      .set(auth())
      .send({ isActive: false })
      .expect(200);
    expect(mine(await list())).not.toContain(`${P}Extra renamed`);
    await open(extra.id).expect(404); // pool was cached: deactivation still wins at once
    await server().delete(`${MANUAL}/${extra.id}`).set(auth()).expect(204);
    expect(mine(await list())).not.toContain(`${P}Extra renamed`);
    await open(extra.id).expect(404);
  });

  it('POST /simulator/packs validates setId (400, no errorCode): empty, non UUID, wrong type, empty body', async () => {
    for (const v of ['', 'has space', 'e2e164-big', 'x'.repeat(65), 123]) {
      const r = await open(v).expect(400);
      expect((r.body as Err).errorCode).toBeUndefined();
    }
    await server().post('/api/v1/simulator/packs').send({}).expect(400);
  });

  it('404 SIMULATOR_SET_NOT_FOUND is identical for unknown, inactive and not-ready sets', async () => {
    const bodies = [];
    for (const id of [UUID0, inactive.id, notReady.id]) {
      bodies.push((await open(id).expect(404)).body);
    }
    expect((bodies[0] as Err).errorCode).toBe('SIMULATOR_SET_NOT_FOUND');
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('200 pack: contract shape, 10 distinct cards of the set, rare last, reverse before it, 0 TCG calls, nothing persisted', async () => {
    const tcg = app.get<TcgApiClient>(TCG_API_CLIENT);
    const spies = (['listSets', 'listSetCards'] as const).map((m) =>
      vi.spyOn(tcg, m),
    );
    const [products0, orders0] = await Promise.all([
      prisma.product.count(),
      prisma.order.count(),
    ]);
    const res = await open(big.id).expect(200);
    const body = res.body as PackBody;
    expect(Object.keys(body).sort()).toEqual([
      'cards',
      'pricedCards',
      'set',
      'totalValueUsd',
      'unpricedCards',
    ]);
    expect(body.set).toEqual({
      setId: big.id,
      gameSlug: 'pokemon',
      name: `${P}Big`,
    });
    // Same keys/types as the legacy public DTO (frontend contract).
    expect(Object.keys(body.cards[0]).sort()).toEqual([
      'id',
      'imageUrl',
      'isReverse',
      'marketPriceUsd',
      'name',
      'number',
      'position',
      'product',
      'rarityRaw',
      'rarityTier',
    ]);
    expect(body.cards).toHaveLength(10);
    expect(body.cards.map((c) => c.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(new Set(body.cards.map((c) => c.id)).size).toBe(10);
    for (const c of body.cards) {
      expect(big.cardIds).toContain(c.id);
      expect(c.rarityRaw).toBe(c.rarityTier);
      expect(c.product).toBeNull();
      expect(typeof c.name).toBe('string');
    }
    expect(RARE_TIERS).toContain(body.cards[9].rarityTier);
    expect(body.cards.slice(7, 9).every((c) => c.isReverse)).toBe(true);
    const cents = body.cards.reduce(
      (a, c) =>
        a + (c.marketPriceUsd == null ? 0 : Math.round(c.marketPriceUsd * 100)),
      0,
    );
    expect(body.totalValueUsd).toBe(cents / 100);
    expect(body.pricedCards + body.unpricedCards).toBe(10);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(await prisma.product.count()).toBe(products0);
    expect(await prisma.order.count()).toBe(orders0);
  });

  it('warm cache: ONE primary-key read per opening, no card query, no Products query', async () => {
    await open(big.id).expect(200);
    const one = vi.spyOn(prisma.simulatorSet, 'findUnique');
    const cards = vi.spyOn(prisma.simulatorCard, 'findMany');
    const raw = vi.spyOn(prisma, '$queryRaw');
    await open(big.id).expect(200);
    expect(one).toHaveBeenCalledTimes(1);
    expect(cards).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    one.mockRestore();
    cards.mockRestore();
    raw.mockRestore();
  });

  it('pool cache is keyed by version: editing a card never serves the old pool', async () => {
    const set = await seedManualSet(prisma, {
      name: `${P}Versioned`,
      tiers: MIN_TIERS,
    });
    const first = (await open(set.id).expect(200)).body as PackBody;
    const victim = first.cards[0];
    // Bypass 22.5 and the cache listener on purpose: only `version` changes.
    await prisma.simulatorCard.update({
      where: { id: victim.id },
      data: { name: 'RENAMED-BY-SQL' },
    });
    const stillOld = (await open(set.id).expect(200)).body as PackBody;
    expect(stillOld.cards.find((c) => c.id === victim.id)?.name).toBe(
      victim.name,
    );
    await prisma.simulatorSet.update({
      where: { id: set.id },
      data: { version: { increment: 1 } },
    });
    for (let i = 0; i < 30; i++) {
      const b = (await open(set.id, `198.51.100.${10 + i}`).expect(200))
        .body as PackBody;
      const c = b.cards.find((x) => x.id === victim.id);
      if (c) expect(c.name).toBe('RENAMED-BY-SQL');
    }
  });

  it('an active set that lost cards by manual SQL answers 404 and logs the broken invariant', async () => {
    const set = await seedManualSet(prisma, {
      name: `${P}Broken`,
      tiers: MIN_TIERS,
    });
    await prisma.simulatorCard.deleteMany({
      where: { setId: set.id, rarityTier: { not: 'COMMON' } },
    });
    await prisma.simulatorSet.update({
      where: { id: set.id },
      data: { version: { increment: 1 } },
    });
    cache().clear();
    expect(mine(await list())).not.toContain(`${P}Broken`);
    const r = await open(set.id).expect(404);
    expect((r.body as Err).errorCode).toBe('SIMULATOR_SET_NOT_FOUND');
  });

  it('PUT /admin/simulator/config still validates but no longer affects the public list', async () => {
    const before = await list();
    await server()
      .put(CFG)
      .set(auth())
      .send({ templates: { pokemon: defaultPokemonTemplate() }, sets: [] })
      .expect(200);
    expect(await list()).toEqual(before);
    await server()
      .put(CFG)
      .set(auth())
      .send({ templates: { pokemon: { slots: [] } }, sets: [] })
      .expect(400);
    await server().get(CFG).set(auth()).expect(200);
    await server().get('/api/v1/admin/simulator/sets').set(auth()).expect(200);
  });

  it('1000 openings (minimum-ready and roomy set): 10 cards, 0 duplicates, rare last, never insufficient', async () => {
    const gen = app.get(PackGeneratorService);
    const tally = new Map<string, number>();
    for (const setId of [min.id, big.id]) {
      for (let i = 0; i < 1000; i++) {
        const p = await gen.open(setId);
        expect(p.cards).toHaveLength(10);
        expect(new Set(p.cards.map((c) => c.id)).size).toBe(10);
        const last = p.cards[9].rarityTier;
        expect(RARE_TIERS).toContain(last);
        if (setId === big.id) tally.set(last, (tally.get(last) ?? 0) + 1);
      }
    }
    // Rare slot odds 70/15/6/6/2/1 over 1000 draws: wide statistical tolerance.
    const frac = (t: string) => (tally.get(t) ?? 0) / 1000;
    expect(frac('RARE')).toBeGreaterThan(0.62);
    expect(frac('RARE')).toBeLessThan(0.78);
    expect(frac('DOUBLE_RARE')).toBeGreaterThan(0.1);
    expect(frac('DOUBLE_RARE')).toBeLessThan(0.21);
    expect(frac('HYPER_RARE')).toBeLessThan(0.04);
  }, 60_000);

  it('p95 < 300 ms preparing a pack with a warm pool over 200 openings', async () => {
    const gen = app.get(PackGeneratorService);
    await gen.open(big.id);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await gen.open(big.id);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[189]).toBeLessThan(300);
  });

  it('opening while the set is being deactivated: every response is a valid 200 or a 404, never 500', async () => {
    const set = await seedManualSet(prisma, {
      name: `${P}Race`,
      tiers: BIG_TIERS,
    });
    const gen = app.get(PackGeneratorService);
    await gen.open(set.id); // warm
    const attempt = () =>
      gen.open(set.id).then(
        (b) => ({ status: 200, body: b }),
        (e: unknown) => ({
          status: e instanceof ApiException ? e.getStatus() : 500,
          body: null,
        }),
      );
    const [patched, ...results] = await Promise.all([
      server()
        .patch(`${MANUAL}/${set.id}`)
        .set(auth())
        .send({ isActive: false }),
      ...Array.from({ length: 24 }, attempt),
    ]);
    expect(patched.status).toBe(200);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
      if (r.status === 200) {
        expect(r.body!.cards).toHaveLength(10);
        expect(new Set(r.body!.cards.map((c) => c.id)).size).toBe(10);
      }
    }
    await open(set.id).expect(404);
  });

  it('rate limit: the 31st request in a minute from one IP is 429 with Retry-After; another IP is unaffected', async () => {
    const ip = '203.0.113.164';
    for (let i = 0; i < 30; i++) await open(big.id, ip).expect(200);
    const blocked = await open(big.id, ip).expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await open(big.id, '203.0.113.165').expect(200);
  });
});
