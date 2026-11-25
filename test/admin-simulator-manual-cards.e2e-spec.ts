import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { PACK_TIERS } from './../src/simulator/pack-tiers.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-22-5';
const EMAIL = 'e2e-admin-story-22-5@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-5';
const BASE = '/api/v1/admin/simulator/manual-sets';
const TAG = `e2e225-${Date.now()}`;
const UUID0 = '00000000-0000-4000-8000-000000000000';
const tpl = (commons: number) => ({
  slots: [
    { kind: 'fixed', tier: 'COMMON', count: commons },
    { kind: 'rare', odds: { RARE: 100 } },
  ],
});

interface Body {
  errorCode?: string;
  details?: {
    max?: number;
    current?: number;
    incoming?: number;
    missing?: { slot: string }[];
  };
  id?: string;
  setId?: string;
  name?: string;
  rarityTier?: string;
  number?: string | null;
  imageUrl?: string | null;
  marketPriceUsd?: number | null;
  createdAt?: string;
  updatedAt?: string;
  isActive?: boolean;
  cardCount?: number;
  cardCountByTier?: Record<string, number>;
  readiness?: { ready: boolean };
  data?: Body[];
  meta?: { total: number; limit: number; page: number; totalPages: number };
}

/** Story 22.5: admin CRUD of manual cards (AC1-AC11) against the real (throw-away) database. */
describe('Admin manual simulator cards (e2e, Story 22.5)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let preexisting: string[];
  const savedMax = process.env.SIMULATOR_MAX_CARDS_PER_SET;

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let n = 0;
  const uniq = (s = 's') => `${TAG}-${s}-${++n}`;
  const mkSet = async (body: object = {}): Promise<string> =>
    (
      (
        await server()
          .post(BASE)
          .set(auth())
          .send({ name: uniq(), ...body })
          .expect(201)
      ).body as Body
    ).id as string;
  const cards = (setId: string) => `${BASE}/${setId}/cards`;
  const post = (setId: string, body: object) =>
    server().post(cards(setId)).set(auth()).send(body);
  const mkCard = async (setId: string, body: object = {}): Promise<Body> =>
    (
      await post(setId, {
        name: uniq('c'),
        rarityTier: 'COMMON',
        ...body,
      }).expect(201)
    ).body as Body;
  const patch = (setId: string, cardId: string, body: object) =>
    server()
      .patch(`${cards(setId)}/${cardId}`)
      .set(auth())
      .send(body);
  const del = (setId: string, cardId: string) =>
    server()
      .delete(`${cards(setId)}/${cardId}`)
      .set(auth());
  const getSet = async (id: string) =>
    (await server().get(`${BASE}/${id}`).set(auth()).expect(200)).body as Body;
  const version = async (id: string) =>
    (await prisma.simulatorSet.findUniqueOrThrow({ where: { id } })).version;
  const events = (entityId: string) =>
    prisma.$queryRaw<
      {
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        entityType: string;
        emittedBy: string | null;
      }[]
    >`SELECT "action","before","after","entityType" FROM "Audit_Events" WHERE "entityId" = ${entityId} ORDER BY "seq"`;
  /** `commons` COMMON + 1 RARE cards straight into the DB: ready for `tpl(n <= commons)`. */
  const seed = (setId: string, commons: number) =>
    prisma.simulatorCard.createMany({
      data: [
        ...Array.from({ length: commons }, (_, i) => ({
          setId,
          name: `c${i}`,
          rarityTier: 'COMMON' as const,
          number: `${i}`,
        })),
        { setId, name: 'r', rarityTier: 'RARE' as const, number: 'r' },
      ],
    });
  const cardIds = async (setId: string, tier: 'COMMON' | 'RARE') =>
    (
      await prisma.simulatorCard.findMany({
        where: { setId, rarityTier: tier },
        select: { id: true },
        orderBy: { name: 'asc' },
      })
    ).map((c) => c.id);

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
    preexisting = (
      await prisma.simulatorSet.findMany({ select: { id: true } })
    ).map((s) => s.id);
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
  });

  afterAll(async () => {
    if (savedMax === undefined) delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
    else process.env.SIMULATOR_MAX_CARDS_PER_SET = savedMax;
    await prisma.simulatorSet.deleteMany({
      where: { id: { notIn: preexisting } },
    });
    await app.close();
  });

  describe('AC1/AC2/AC3: routes, shape, validation, filters', () => {
    it('401 without a session on every route', async () => {
      await server().get(cards(UUID0)).expect(401);
      await server().post(cards(UUID0)).send({}).expect(401);
      await server()
        .patch(`${cards(UUID0)}/${UUID0}`)
        .send({})
        .expect(401);
      await server()
        .delete(`${cards(UUID0)}/${UUID0}`)
        .expect(401);
    });

    it('POST 201 returns the full CardDto; price is a number; number blank -> null', async () => {
      const s = await mkSet();
      const c = await mkCard(s, {
        name: '  Charizard  ',
        rarityTier: 'ULTRA_RARE',
        number: '  ',
        marketPriceUsd: 12.3,
        imageUrl: 'https://img.example.com/c.png',
      });
      expect(c).toMatchObject({
        setId: s,
        name: 'Charizard',
        rarityTier: 'ULTRA_RARE',
        number: null,
        marketPriceUsd: 12.3,
        imageUrl: 'https://img.example.com/c.png',
      });
      expect(typeof c.marketPriceUsd).toBe('number');
      expect(c.createdAt && c.updatedAt).toBeTruthy();
      const z = await mkCard(s, { marketPriceUsd: 0 });
      expect(z.marketPriceUsd).toBe(0);
      expect((await mkCard(s)).marketPriceUsd).toBeNull();
    });

    it.each([
      ['empty name', { name: '   ' }],
      ['long name', { name: 'x'.repeat(121) }],
      ['tier lower-case', { rarityTier: 'rare' }],
      ['tier promo', { rarityTier: 'promo' }],
      ['tier missing', { rarityTier: undefined }],
      ['long number', { number: '9'.repeat(31) }],
      ['negative price', { marketPriceUsd: -0.01 }],
      ['3 decimals', { marketPriceUsd: 1.234 }],
      ['string price', { marketPriceUsd: 'abc' }],
      ['string 1e3', { marketPriceUsd: '1e3' }],
      ['http image', { imageUrl: 'http://x.io/a.png' }],
      ['bad own path', { imageUrl: '/uploads/public/other/a.png' }],
      ['PII number', { number: 'V-12345678' }],
      ['PII imageUrl', { imageUrl: 'https://u:p@x.io/a.png' }],
    ])('POST 400: %s', async (_l, over) => {
      const s = await mkSet();
      await post(s, { name: 'ok', rarityTier: 'COMMON', ...over }).expect(400);
      expect((await getSet(s)).cardCount).toBe(0);
      expect(await version(s)).toBe(1);
    });

    it('accepts real TCG numbers and a name that looks like an ID document', async () => {
      const s = await mkSet();
      for (const num of ['025/165', 'SV-P 001', 'TG12/TG30', 'GG01'])
        expect((await mkCard(s, { number: num })).number).toBe(num);
      const c = await mkCard(s, { name: 'V-12345678' });
      expect(c.name).toBe('V-12345678');
    });

    it('GET: {data, meta}, ordered by name,id, paginated, tier/q filters', async () => {
      const s = await mkSet();
      await mkCard(s, { name: 'b card', rarityTier: 'RARE' });
      await mkCard(s, { name: 'A card' });
      await mkCard(s, { name: '100% pure_x' });
      await mkCard(s, { name: '100X pureAx' });
      const all = (await server().get(cards(s)).set(auth()).expect(200))
        .body as Body;
      expect(all.meta).toMatchObject({ page: 1, limit: 50, total: 4 });
      const names = (all.data ?? []).map((c) => c.name ?? '');
      expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
      const p = (
        await server()
          .get(`${cards(s)}?page=2&limit=3`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect(p.data).toHaveLength(1);
      expect(p.meta).toMatchObject({ page: 2, limit: 3, totalPages: 2 });
      const rare = (
        await server()
          .get(`${cards(s)}?tier=RARE`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect(rare.data?.map((c) => c.name)).toEqual(['b card']);
      const ci = (
        await server()
          .get(`${cards(s)}?q=A%20CARD`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect(ci.data?.map((c) => c.name)).toEqual(['A card']);
      // % and _ are literals
      const pct = (
        await server()
          .get(`${cards(s)}?q=%25`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect(pct.data?.map((c) => c.name)).toEqual(['100% pure_x']);
      const und = (
        await server()
          .get(`${cards(s)}?q=_`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect(und.data?.map((c) => c.name)).toEqual(['100% pure_x']);
      await server()
        .get(`${cards(s)}?tier=XX`)
        .set(auth())
        .expect(400);
      await server()
        .get(`${cards(s)}?limit=101`)
        .set(auth())
        .expect(400);
    });

    it('404s: unknown set on every verb, foreign/unknown card, non-uuid ids 400', async () => {
      const s = await mkSet();
      const other = await mkSet();
      const c = await mkCard(other);
      const setNf = 'SIMULATOR_SET_NOT_FOUND';
      const cardNf = 'SIMULATOR_CARD_NOT_FOUND';
      const eq = (r: { body: unknown }, code: string) =>
        expect((r.body as Body).errorCode).toBe(code);
      eq(await server().get(cards(UUID0)).set(auth()).expect(404), setNf);
      eq(
        await post(UUID0, { name: 'x', rarityTier: 'COMMON' }).expect(404),
        setNf,
      );
      eq(await patch(UUID0, c.id as string, { name: 'y' }).expect(404), setNf);
      eq(await del(UUID0, c.id as string).expect(404), setNf);
      eq(await patch(s, c.id as string, { name: 'y' }).expect(404), cardNf);
      eq(await del(s, c.id as string).expect(404), cardNf);
      eq(await patch(s, UUID0, { name: 'y' }).expect(404), cardNf);
      await server().get(cards('nope')).set(auth()).expect(400);
      await patch(s, 'nope', {}).expect(400);
      await del(s, 'nope').expect(400);
      expect(
        await prisma.simulatorCard.count({ where: { setId: other } }),
      ).toBe(1);
    });

    it('PATCH: partial update, null clears number/imageUrl/price, null name/tier is 400', async () => {
      const s = await mkSet();
      const c = await mkCard(s, {
        number: '7',
        imageUrl: 'https://img.example.com/c.png',
        marketPriceUsd: 5,
      });
      const r = (
        await patch(s, c.id as string, {
          name: 'Renamed',
          number: null,
          imageUrl: null,
          marketPriceUsd: null,
        }).expect(200)
      ).body as Body;
      expect(r).toMatchObject({
        name: 'Renamed',
        number: null,
        imageUrl: null,
        marketPriceUsd: null,
        rarityTier: 'COMMON',
      });
      await patch(s, c.id as string, { name: null }).expect(400);
      await patch(s, c.id as string, { rarityTier: null }).expect(400);
      await patch(s, c.id as string, { rarityTier: 'promo' }).expect(400);
      await patch(s, c.id as string, { marketPriceUsd: 1.001 }).expect(400);
      await patch(s, c.id as string, { number: 'V-12345678' }).expect(400);
      await del(s, c.id as string).expect(204);
      await del(s, c.id as string).expect(404);
    });
  });

  describe('AC4: number uniqueness', () => {
    it('duplicate number 409 on POST and PATCH; null / other sets / same number on itself allowed', async () => {
      const s = await mkSet();
      const s2 = await mkSet();
      const a = await mkCard(s, { number: '1' });
      const b = await mkCard(s, { number: '2' });
      const dup = await post(s, {
        name: 'z',
        rarityTier: 'COMMON',
        number: '1',
      }).expect(409);
      expect((dup.body as Body).errorCode).toBe('SIMULATOR_CARD_NUMBER_TAKEN');
      const dp = await patch(s, b.id as string, { number: '1' }).expect(409);
      expect((dp.body as Body).errorCode).toBe('SIMULATOR_CARD_NUMBER_TAKEN');
      await patch(s, a.id as string, {
        number: '1',
        name: 'same number',
      }).expect(200);
      await mkCard(s, { name: 'same name', number: null });
      await mkCard(s, { name: 'same name', number: null });
      await mkCard(s, { name: 'same name', number: '3' });
      await mkCard(s2, { number: '1' });
      expect(await prisma.simulatorCard.count({ where: { setId: s } })).toBe(5);
    });

    it('simultaneous POSTs with the same number: one 201, the rest 409, never 500', async () => {
      const s = await mkSet();
      const rs = await Promise.all(
        Array.from({ length: 6 }, () =>
          post(s, { name: uniq('r'), rarityTier: 'COMMON', number: 'X1' }),
        ),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409, 409,
      ]);
    });
  });

  describe('AC5: card cap', () => {
    it('422 at the cap with details; counted under the set lock (10 parallel => exactly 5 ok)', async () => {
      process.env.SIMULATOR_MAX_CARDS_PER_SET = '10';
      const s = await mkSet();
      await prisma.simulatorCard.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          setId: s,
          name: `p${i}`,
          rarityTier: 'COMMON' as const,
        })),
      });
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          post(s, { name: `n${i}`, rarityTier: 'COMMON' }),
        ),
      );
      expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
      const bad = rs.filter((r) => r.status === 422);
      expect(bad).toHaveLength(5);
      const b = bad[0].body as Body;
      expect(b.errorCode).toBe('SIMULATOR_SET_CARD_LIMIT');
      expect(b.details).toEqual({ max: 10, current: 10, incoming: 1 });
      expect(await prisma.simulatorCard.count({ where: { setId: s } })).toBe(
        10,
      );
      delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
    });
  });

  describe('AC6/AC11: version, cache, live counts', () => {
    it('every effective write bumps version once; no-op PATCH does not; counts and readiness are live', async () => {
      const s = await mkSet();
      expect(await version(s)).toBe(1);
      const c = await mkCard(s);
      expect(await version(s)).toBe(2);
      await patch(s, c.id as string, { rarityTier: 'RARE' }).expect(200);
      expect(await version(s)).toBe(3);
      let st = await getSet(s);
      expect(st.cardCount).toBe(1);
      expect(st.cardCountByTier).toMatchObject({ COMMON: 0, RARE: 1 });
      await patch(s, c.id as string, { rarityTier: 'RARE' }).expect(200);
      expect(await version(s)).toBe(3);
      await del(s, c.id as string).expect(204);
      expect(await version(s)).toBe(4);
      st = await getSet(s);
      expect(st.cardCount).toBe(0);
      expect(st.readiness?.ready).toBe(false);
    });

    it('a set becomes ready as cards are added and stays accurate', async () => {
      const s = await mkSet({ template: tpl(2) });
      expect((await getSet(s)).readiness?.ready).toBe(false);
      await mkCard(s);
      await mkCard(s);
      await mkCard(s, { rarityTier: 'RARE' });
      const st = await getSet(s);
      expect(st.readiness?.ready).toBe(true);
      expect(st.cardCountByTier).toMatchObject({ COMMON: 2, RARE: 1 });
    });
  });

  describe('AC7: invariant on an active set (A105)', () => {
    it('DELETE/tier change that breaks sufficiency => 422 and nothing changes; others proceed', async () => {
      const s = await mkSet({ template: tpl(2) });
      await seed(s, 3); // 3 COMMON + 1 RARE
      await server()
        .patch(`${BASE}/${s}`)
        .set(auth())
        .send({ isActive: true })
        .expect(200);
      const commons = await cardIds(s, 'COMMON');
      const rares = await cardIds(s, 'RARE');
      const v0 = await version(s);
      const ev0 = (await events(s)).length;
      // the only RARE: rare slot needs >= 1
      const r1 = await del(s, rares[0]).expect(422);
      expect((r1.body as Body).errorCode).toBe('SIMULATOR_SET_NOT_READY');
      expect((r1.body as Body).details?.missing?.length).toBeGreaterThan(0);
      const r2 = await patch(s, rares[0], { rarityTier: 'COMMON' }).expect(422);
      expect((r2.body as Body).errorCode).toBe('SIMULATOR_SET_NOT_READY');
      expect(await prisma.simulatorCard.count({ where: { setId: s } })).toBe(4);
      expect(
        (
          await prisma.simulatorCard.findUniqueOrThrow({
            where: { id: rares[0] },
          })
        ).rarityTier,
      ).toBe('RARE');
      expect(await version(s)).toBe(v0);
      expect((await events(s)).length).toBe(ev0);
      // 3 commons for fixed 2: one may go, the next may not
      await del(s, commons[0]).expect(204);
      await del(s, commons[1]).expect(422);
      await patch(s, commons[1], { rarityTier: 'RARE' }).expect(422);
      // a tier move that keeps sufficiency proceeds
      await patch(s, commons[2], { name: 'renamed', marketPriceUsd: 3 }).expect(
        200,
      );
      const st = await getSet(s);
      expect(st.isActive).toBe(true);
      expect(st.readiness?.ready).toBe(true);
    });

    it('non-tier edits of an active set never evaluate sufficiency; inactive sets are unchecked; create only adds', async () => {
      const s = await mkSet({ template: tpl(2) });
      await seed(s, 2);
      await server()
        .patch(`${BASE}/${s}`)
        .set(auth())
        .send({ isActive: true })
        .expect(200);
      const rares = await cardIds(s, 'RARE');
      await patch(s, rares[0], { name: 'still ok' }).expect(200);
      await mkCard(s, { rarityTier: 'UNCOMMON' });
      const inactive = await mkSet({ template: tpl(2) });
      await seed(inactive, 2);
      const ir = await cardIds(inactive, 'RARE');
      await del(inactive, ir[0]).expect(204);
      expect((await getSet(inactive)).readiness?.ready).toBe(false);
    });
  });

  describe('AC8: audit', () => {
    it('CREATED/UPDATED/DELETED with emitter payload {setId, rarityTier, number} and NO name; no-op PATCH emits nothing', async () => {
      const s = await mkSet();
      const c = await mkCard(s, { name: 'Secret Name', number: '025/165' });
      const id = c.id as string;
      await patch(s, id, { name: 'Other Name' }).expect(200);
      await patch(s, id, { rarityTier: 'RARE', number: 'SV-P 001' }).expect(
        200,
      );
      await patch(s, id, { rarityTier: 'RARE', number: 'SV-P 001' }).expect(
        200,
      ); // no-op
      await del(s, id).expect(204);
      const ev = await events(id);
      expect(ev.map((e) => e.action)).toEqual([
        'SIMULATOR_CARD_CREATED',
        'SIMULATOR_CARD_UPDATED',
        'SIMULATOR_CARD_UPDATED',
        'SIMULATOR_CARD_DELETED',
      ]);
      expect(ev.every((e) => e.entityType === 'SimulatorCard')).toBe(true);
      expect(ev[0].after).toEqual({
        setId: s,
        rarityTier: 'COMMON',
        number: '025/165',
      });
      expect(ev[2].before).toEqual({
        setId: s,
        rarityTier: 'COMMON',
        number: '025/165',
      });
      expect(ev[2].after).toEqual({
        setId: s,
        rarityTier: 'RARE',
        number: 'SV-P 001',
      });
      expect(ev[3].before).toEqual({
        setId: s,
        rarityTier: 'RARE',
        number: 'SV-P 001',
      });
      expect(JSON.stringify(ev)).not.toMatch(/Secret Name|Other Name/);
    });

    it('a card named V-12345678 is accepted, audited without its name, and can be edited/deleted', async () => {
      const s = await mkSet();
      const c = await mkCard(s, { name: 'V-12345678', number: null });
      await patch(s, c.id as string, {
        name: 'V-87654321',
        marketPriceUsd: 1,
      }).expect(200);
      await patch(s, c.id as string, { rarityTier: 'RARE' }).expect(200);
      await del(s, c.id as string).expect(204);
      expect((await events(c.id as string)).length).toBe(4);
    });
  });

  describe('AC9: concurrency', () => {
    it('two DELETEs of the same critical tier on a just-sufficient active set: at most one proceeds', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await mkSet({ template: tpl(2) });
        await seed(s, 3); // fixed 2 + one spare
        await server()
          .patch(`${BASE}/${s}`)
          .set(auth())
          .send({ isActive: true })
          .expect(200);
        const [a, b] = await cardIds(s, 'COMMON');
        const rs = await Promise.all([del(s, a), del(s, b)]);
        expect(rs.map((r) => r.status).sort()).toEqual([204, 422]);
        const st = await getSet(s);
        expect(st.isActive && st.readiness?.ready).toBe(true);
      }
    });

    it('activate vs DELETE of a needed card: never active without sufficiency', async () => {
      for (let round = 0; round < 4; round++) {
        const s = await mkSet({ template: tpl(2) });
        await seed(s, 2); // exactly sufficient
        const [a] = await cardIds(s, 'COMMON');
        await Promise.all([
          server().patch(`${BASE}/${s}`).set(auth()).send({ isActive: true }),
          del(s, a),
        ]);
        const st = await getSet(s);
        if (st.isActive) expect(st.readiness?.ready).toBe(true);
      }
    });

    it('two PATCHes moving different COMMONs away from a just-sufficient active set: at most one proceeds', async () => {
      const s = await mkSet({ template: tpl(2) });
      await seed(s, 3);
      await server()
        .patch(`${BASE}/${s}`)
        .set(auth())
        .send({ isActive: true })
        .expect(200);
      const [a, b] = await cardIds(s, 'COMMON');
      const rs = await Promise.all([
        patch(s, a, { rarityTier: 'RARE' }),
        patch(s, b, { rarityTier: 'RARE' }),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await getSet(s)).readiness?.ready).toBe(true);
    });
  });

  it('all 8 tiers are accepted', async () => {
    const s = await mkSet();
    for (const t of PACK_TIERS)
      expect((await mkCard(s, { rarityTier: t })).rarityTier).toBe(t);
  });
});
