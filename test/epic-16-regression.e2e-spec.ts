import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  type TcgApiClient,
} from './../src/tcg/tcg-api-client.interface.js';
import { SimulatorPoolCache } from './../src/simulator/pool-cache.js';
import { defaultPokemonTemplate } from './../src/simulator/simulator-defaults.js';
import { validBlock } from './../src/admin-landing/landing-blocks.fixtures.js';

type App = Parameters<typeof request>[0];
const P = 'e2e1611-';
const SET = `${P}set`;
const USER = 'e2e-admin-story-16-11a';
const PASS = 'correct-horse-battery-staple-16-11a';
const CUSTOMER_EMAIL = 'e2e-customer-story-16-11a@212collectorsclub.test';
const CUSTOMER_PASS = 'correct-horse-battery-staple-16-11a';
const LANDING = '/api/v1/admin/landing-content';
const SIM = '/api/v1/admin/simulator';

interface Err {
  errorCode?: string;
}
type PublicHome = {
  home?: Record<string, { value: { products?: { id: string }[] } }>;
};

/**
 * Story 16.11a (FR-71..80; NFR-16.1/16.3/16.4). Transversal Epic 16
 * regression over real Postgres. All fixtures are Prisma-seeded (prefix
 * `e2e1611-`, no tcgapi call) and removed at the end; pre-existing `home`
 * rows and the `pack_simulator/config` row are snapshotted and restored.
 */
describe('Epic 16 regression (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: string;
  let token: string;
  let customerCookie: string;
  let categoryId: string;
  let ownsCategory = false;
  let homeSnapshot: Awaited<
    ReturnType<PrismaService['landingConfigEntry']['findMany']>
  > = [];
  let configSnapshot: Awaited<
    ReturnType<PrismaService['landingConfigEntry']['findUnique']>
  > = null;
  const productIds: string[] = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const wipeHome = () =>
    prisma.landingConfigEntry.deleteMany({ where: { section: 'home' } });
  const open = (ip: string) =>
    server()
      .post('/api/v1/simulator/packs')
      .set('X-Forwarded-For', ip)
      .send({ setId: SET });

  const mkProduct = async (o: { isActive?: boolean; stock: number }) => {
    const p = await prisma.product.create({
      data: {
        name: `E2E1611 ${randomUUID().slice(0, 6)}`,
        slug: `${P}${randomUUID().slice(0, 8)}`,
        description: 'e2e 16.11a',
        franchise: 'POKEMON',
        productType: 'BOOSTER_PACK',
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock: o.stock,
        heldQty: 0,
        isActive: o.isActive ?? true,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  };

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

  const cleanFixtures = async () => {
    await prisma.product.deleteMany({ where: { slug: { startsWith: P } } });
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: P } },
    });
    await prisma.tcgIngestCursor.deleteMany({
      where: { setId: { startsWith: P } },
    });
  };

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
    await cleanFixtures();

    homeSnapshot = await prisma.landingConfigEntry.findMany({
      where: { section: 'home' },
    });
    configSnapshot = await prisma.landingConfigEntry.findUnique({
      where: { section_key: { section: 'pack_simulator', key: 'config' } },
    });
    await wipeHome();

    const existingCat = await prisma.category.findFirst();
    if (existingCat) categoryId = existingCat.id;
    else {
      categoryId = (
        await prisma.category.create({
          data: { name: 'e2e-16-11a', slug: 'e2e-16-11a' },
        })
      ).id;
      ownsCategory = true;
    }

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

    await prisma.customer.deleteMany({ where: { email: CUSTOMER_EMAIL } });
    await server()
      .post('/api/v1/auth/register')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASS, name: 'Ada' })
      .expect(201);
    const cl = await server()
      .post('/api/v1/auth/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASS })
      .expect(200);
    const sc = (cl.headers['set-cookie'] as unknown as string[]).find((s) =>
      s.startsWith('cc_session='),
    )!;
    customerCookie = sc.split(';')[0];

    // 120 unique cards + 30 reverse printings of the first 30 commons.
    const base = (n: number, over: Record<string, unknown>) => ({
      externalProvider: provider,
      name: `E2E1611 Card ${n}`,
      cleanName: `e2e1611 card ${n}`,
      searchText: `e2e1611 card ${n}`,
      franchise: 'POKEMON' as const,
      gameSlug: 'pokemon',
      setId: SET,
      setName: 'E2E 16.11a Set',
      cardNumber: String(n),
      rarity: rar(n),
      printing: 'Normal',
      marketPriceUsd: (n * 0.5).toString(),
      rawApiData: {},
      ...over,
    });
    await prisma.masterCard.createMany({
      data: [
        ...Array.from({ length: 120 }, (_, i) =>
          base(i + 1, { externalId: `${P}${i + 1}` }),
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          base(i + 1, {
            externalId: `${P}${i + 1}-rev`,
            printing: 'Reverse Holofoil',
          }),
        ),
      ],
    });
    await prisma.tcgIngestCursor.create({
      data: {
        gameSlug: 'pokemon',
        setId: SET,
        setName: 'E2E 16.11a Set',
        status: 'DONE',
      },
    });
    await server()
      .put(`${SIM}/config`)
      .set(auth())
      .send({
        templates: { pokemon: defaultPokemonTemplate() },
        sets: [{ gameSlug: 'pokemon', setId: SET, displayName: 'E2E 16.11a' }],
      })
      .expect(200);
    app.get(SimulatorPoolCache).clear();
  });

  afterAll(async () => {
    await cleanFixtures();
    if (ownsCategory)
      await prisma.category.deleteMany({ where: { slug: 'e2e-16-11a' } });
    await wipeHome();
    if (homeSnapshot.length)
      await prisma.landingConfigEntry.createMany({ data: homeSnapshot });
    await prisma.landingConfigEntry.deleteMany({
      where: { section: 'pack_simulator', key: 'config' },
    });
    if (configSnapshot)
      await prisma.landingConfigEntry.create({ data: configSnapshot });
    await prisma.customer.deleteMany({ where: { email: CUSTOMER_EMAIL } });
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  beforeEach(wipeHome);

  const publicHome = async () =>
    (
      (await server().get('/api/v1/landing-content').expect(200))
        .body as PublicHome
    ).home;

  it('(a) a draft is invisible publicly and visible in the admin draft view', async () => {
    await server()
      .put(`${LANDING}/blocks/ticker`)
      .set(auth())
      .send(validBlock('ticker'))
      .expect(200);
    expect((await publicHome())?.ticker).toBeUndefined();
    const draft = (
      await server().get(`${LANDING}/draft`).set(auth()).expect(200)
    ).body as { blocks: Record<string, unknown>; draftBlocks: string[] };
    expect(draft.draftBlocks).toEqual(['ticker']);
    expect(draft.blocks.ticker).toEqual(validBlock('ticker'));
    await server()
      .post(`${LANDING}/blocks/ticker/publish`)
      .set(auth())
      .expect(200);
    expect((await publicHome())?.ticker?.value).toEqual(validBlock('ticker'));
  });

  it('(b) public vitrina omits inactive and out-of-stock products and keeps order', async () => {
    const a = await mkProduct({ stock: 5 });
    const b = await mkProduct({ stock: 0 });
    const c = await mkProduct({ stock: 5, isActive: false });
    const d = await mkProduct({ stock: 3 });
    await server()
      .put(`${LANDING}/blocks/vitrina`)
      .set(auth())
      .send(validBlock('vitrina', [d, c, b, a]))
      .expect(200);
    await server()
      .post(`${LANDING}/blocks/vitrina/publish`)
      .set(auth())
      .expect(200);
    const ids = ((await publicHome())?.vitrina?.value.products ?? []).map(
      (p) => p.id,
    );
    expect(ids).toEqual([d, a]);
  });

  it('(c) odds != 100 are rejected and the reserved key is blocked on the free PUT', async () => {
    const cfg = {
      templates: { pokemon: defaultPokemonTemplate() },
      sets: [{ gameSlug: 'pokemon', setId: SET }],
    };
    (cfg.templates.pokemon.slots[3] as { odds: object }).odds = {
      RARE: 60,
      DOUBLE_RARE: 39,
    };
    const bad = await server()
      .put(`${SIM}/config`)
      .set(auth())
      .send(cfg)
      .expect(400);
    expect((bad.body as Err).errorCode).toBe('SIMULATOR_ODDS_INVALID_SUM');
    const reserved = await server()
      .put(`${LANDING}/pack_simulator/config`)
      .set(auth())
      .send({ value: { a: 1 } })
      .expect(400);
    expect((reserved.body as Err).errorCode).toBe('LANDING_KEY_RESERVED');
  });

  it('(d) sets count unique cards; a pack has 10 distinct cards, rare last; the 31st request/min is 429', async () => {
    const sets = (await server().get('/api/v1/simulator/sets').expect(200))
      .body as { data: { setId: string; cardCount: number }[] };
    expect(sets.data.find((s) => s.setId === SET)?.cardCount).toBe(120);
    const admin = (await server().get(`${SIM}/sets`).set(auth()).expect(200))
      .body as { data: { setId: string; cardCount: number }[] };
    expect(admin.data.find((s) => s.setId === SET)?.cardCount).toBe(120);

    const ip = '203.0.113.1611';
    let first: { cards: { id: string; rarityTier: string }[] } | null = null;
    for (let i = 0; i < 30; i++) {
      const r = await open(ip).expect(200);
      first ??= r.body as typeof first;
    }
    expect(first!.cards).toHaveLength(10);
    expect(new Set(first!.cards.map((c) => c.id)).size).toBe(10);
    expect([
      'RARE',
      'DOUBLE_RARE',
      'ULTRA_RARE',
      'ILLUSTRATION_RARE',
      'SPECIAL_ILLUSTRATION_RARE',
      'HYPER_RARE',
    ]).toContain(first!.cards[9].rarityTier);
    await open(ip).expect(429);
  });

  it('(e) every new admin endpoint is 401 without a token and with a customer session', async () => {
    const routes: [string, string][] = [
      ['get', `${LANDING}/blocks`],
      ['get', `${LANDING}/draft`],
      ['get', `${LANDING}/blocks/hero`],
      ['put', `${LANDING}/blocks/hero`],
      ['post', `${LANDING}/blocks/hero/publish`],
      ['delete', `${LANDING}/blocks/hero/draft`],
      ['post', `${LANDING}/publish`],
      ['post', `${LANDING}/images`],
      ['get', `${SIM}/config`],
      ['put', `${SIM}/config`],
      ['get', `${SIM}/sets`],
    ];
    type Method = 'get' | 'put' | 'post' | 'delete';
    for (const [m, url] of routes) {
      const call = () => server()[m as Method](url);
      await call().expect(401);
      await call().set('Cookie', customerCookie).expect(401);
    }
  });
});
