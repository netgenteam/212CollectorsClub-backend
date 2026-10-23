import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { TCG_API_CLIENT } from './../src/tcg/tcg-api-client.interface.js';
import type { TcgApiClient } from './../src/tcg/tcg-api-client.interface.js';
import { defaultSimulatorConfig } from './../src/simulator/simulator-defaults.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-16-3';
const EMAIL = 'e2e-admin-story-16-3@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-16-3';
const BASE = '/api/v1/admin/simulator';
const GAME = 'e2e163game';
const SET_OK = 'e2e163-done';
const SET_PENDING = 'e2e163-pending';
const PREFIX = 'e2e163-';

interface Err {
  errorCode?: string;
  details?: { path?: string; sum?: number };
}

/**
 * Story 16.3 (FR-79, AD-66). Seeds its own cursors/cards via Prisma (no
 * tcgapi calls) and removes them afterwards.
 */
describe('Simulator config (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let provider: string;
  let originalConfig: Awaited<
    ReturnType<PrismaService['landingConfigEntry']['findUnique']>
  > = null;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const cleanConfig = () =>
    prisma.landingConfigEntry.deleteMany({
      where: { section: 'pack_simulator', key: 'config' },
    });
  const cleanData = async () => {
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: PREFIX } },
    });
    await prisma.tcgIngestCursor.deleteMany({ where: { gameSlug: GAME } });
  };

  const card = (
    n: number,
    setId: string,
    rarity: string | null,
    extra: { name?: string; printing?: string; provider?: string } = {},
  ) =>
    prisma.masterCard.create({
      data: {
        externalProvider: extra.provider ?? provider,
        externalId: `${PREFIX}${n}`,
        name: extra.name ?? `Card ${n}`,
        cleanName: `card ${n}`,
        searchText: `e2e163 card ${n}`,
        franchise: 'OTHER',
        gameSlug: GAME,
        setId,
        setName: 'E2E 16.3 Set',
        rarity,
        printing: extra.printing ?? null,
        rawApiData: {},
      },
    });

  const validCfg = () => ({
    templates: { [GAME]: defaultSimulatorConfig().templates.pokemon },
    sets: [{ gameSlug: GAME, setId: SET_OK, displayName: 'Mi set' }],
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    provider = app.get<TcgApiClient>(TCG_API_CLIENT).provider;
    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    await prisma.adminUser.upsert({
      where: { username: USER },
      create: { username: USER, email: EMAIL, passwordHash },
      update: { email: EMAIL, passwordHash },
    });
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    await cleanData();
    originalConfig = await prisma.landingConfigEntry.findUnique({
      where: { section_key: { section: 'pack_simulator', key: 'config' } },
    });
    await cleanConfig();
    await prisma.tcgIngestCursor.createMany({
      data: [
        {
          gameSlug: GAME,
          setId: SET_OK,
          setName: 'E2E 16.3 Set',
          status: 'DONE',
        },
        {
          gameSlug: GAME,
          setId: SET_PENDING,
          setName: 'Pending',
          status: 'IN_PROGRESS',
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanConfig();
    if (originalConfig) {
      await prisma.landingConfigEntry.create({ data: originalConfig });
    }
    await cleanData();
    await app.close();
  });

  beforeEach(cleanConfig);

  it('401 without token on every route', async () => {
    await server().get(`${BASE}/config`).expect(401);
    await server().put(`${BASE}/config`).send({}).expect(401);
    await server().get(`${BASE}/sets`).expect(401);
  });

  it('GET config returns defaults when nothing is saved', async () => {
    const res = await server().get(`${BASE}/config`).set(auth()).expect(200);
    expect(res.body).toEqual(defaultSimulatorConfig());
  });

  it('PUT saves, GET returns it, and the row lives in pack_simulator/config', async () => {
    const cfg = validCfg();
    await server().put(`${BASE}/config`).set(auth()).send(cfg).expect(200);
    const res = await server().get(`${BASE}/config`).set(auth()).expect(200);
    expect(res.body).toEqual(cfg);
    const row = await prisma.landingConfigEntry.findUniqueOrThrow({
      where: { section_key: { section: 'pack_simulator', key: 'config' } },
    });
    expect(row.value).toEqual(cfg);
  });

  it('400 SIMULATOR_CONFIG_INVALID on bad shape', async () => {
    const res = await server()
      .put(`${BASE}/config`)
      .set(auth())
      .send({ templates: [], sets: [] })
      .expect(400);
    expect((res.body as Err).errorCode).toBe('SIMULATOR_CONFIG_INVALID');
  });

  it('400 SIMULATOR_ODDS_INVALID_SUM with details, boundaries accepted', async () => {
    const withSum = (total: number) => {
      const rare = Math.min(total, 60);
      const c = validCfg();
      const t = c.templates[GAME];
      (t.slots[3] as { odds: object }).odds = {
        RARE: rare,
        DOUBLE_RARE: total - rare,
      };
      return c;
    };
    for (const bad of [99.9, 100.5]) {
      const res = await server()
        .put(`${BASE}/config`)
        .set(auth())
        .send(withSum(bad))
        .expect(400);
      const body = res.body as Err;
      expect(body.errorCode).toBe('SIMULATOR_ODDS_INVALID_SUM');
      expect(body.details?.sum).toBe(bad);
      expect(body.details?.path).toContain('slots[3].odds');
    }
    for (const ok of [100, 99.9995])
      await server()
        .put(`${BASE}/config`)
        .set(auth())
        .send(withSum(ok))
        .expect(200);
  });

  it('422 SIMULATOR_SET_NOT_INGESTED (pending or unknown cursor)', async () => {
    for (const setId of [SET_PENDING, 'nope']) {
      const c = validCfg();
      c.sets = [{ gameSlug: GAME, setId, displayName: 'x' }];
      const res = await server()
        .put(`${BASE}/config`)
        .set(auth())
        .send(c)
        .expect(422);
      expect((res.body as Err).errorCode).toBe('SIMULATOR_SET_NOT_INGESTED');
    }
  });

  it('422 SIMULATOR_TEMPLATE_REQUIRED, satisfied by a set override', async () => {
    const c = { templates: {}, sets: [{ gameSlug: GAME, setId: SET_OK }] };
    const res = await server()
      .put(`${BASE}/config`)
      .set(auth())
      .send(c)
      .expect(422);
    expect((res.body as Err).errorCode).toBe('SIMULATOR_TEMPLATE_REQUIRED');
    const withOverride = {
      templates: {},
      sets: [
        {
          gameSlug: GAME,
          setId: SET_OK,
          template: defaultSimulatorConfig().templates.pokemon,
        },
      ],
    };
    await server()
      .put(`${BASE}/config`)
      .set(auth())
      .send(withOverride)
      .expect(200);
  });

  it('400 on non-landing imageUrl', async () => {
    const c = validCfg();
    (c.sets[0] as { imageUrl?: string }).imageUrl = '/uploads/other/x.png';
    await server().put(`${BASE}/config`).set(auth()).send(c).expect(400);
  });

  it('free PUT pack_simulator/config is reserved; other keys keep working', async () => {
    const res = await server()
      .put('/api/v1/admin/landing-content/pack_simulator/config')
      .set(auth())
      .send({ value: { a: 1 } })
      .expect(400);
    expect((res.body as Err).errorCode).toBe('LANDING_KEY_RESERVED');
    expect(
      await prisma.landingConfigEntry.count({
        where: { section: 'pack_simulator', key: 'config' },
      }),
    ).toBe(0);
    await server()
      .put('/api/v1/admin/landing-content/pack_simulator/e2e_163_other')
      .set(auth())
      .send({ value: { a: 1 } })
      .expect(200);
    await prisma.landingConfigEntry.deleteMany({
      where: { section: 'pack_simulator', key: 'e2e_163_other' },
    });
  });

  it('GET sets: diagnostics, provider filter, energy exclusion, no pending sets', async () => {
    await card(1, SET_OK, 'Common');
    await card(2, SET_OK, 'common');
    await card(3, SET_OK, 'Special Illustration Rare');
    await card(4, SET_OK, 'Weird Rarity', { printing: 'Reverse Holofoil' });
    await card(5, SET_OK, null);
    await card(6, SET_OK, 'Common', { name: 'Basic Fire Energy' });
    await card(7, SET_OK, 'Hyper Rare', { provider: 'OTHER_PROVIDER' });
    await card(8, SET_PENDING, 'Common');

    await server()
      .put(`${BASE}/config`)
      .set(auth())
      .send(validCfg())
      .expect(200);
    const res = await server().get(`${BASE}/sets`).set(auth()).expect(200);
    const data = (res.body as { data: Record<string, unknown>[] }).data.filter(
      (d) => d.gameSlug === GAME,
    );
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      setId: SET_OK,
      setName: 'E2E 16.3 Set',
      cardCount: 5,
      enabled: true,
      tierCoverage: { COMMON: 2, SPECIAL_ILLUSTRATION_RARE: 1 },
      hasReversePrintings: true,
    });
    expect(data[0].unmappedRarities).toEqual(
      expect.arrayContaining([
        { raw: 'Weird Rarity', count: 1 },
        { raw: null, count: 1 },
      ]),
    );
  });
});
