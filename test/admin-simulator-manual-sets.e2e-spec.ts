import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SimulatorPoolCache } from './../src/simulator/pool-cache.js';
import { PACK_TIERS } from './../src/simulator/pack-tiers.js';
import { defaultPokemonTemplate } from './../src/simulator/simulator-defaults.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-22-4';
const EMAIL = 'e2e-admin-story-22-4@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-4';
const BASE = '/api/v1/admin/simulator/manual-sets';
const TAG = `e2e224-${Date.now()}`;
const tpl = (commons: number) => ({
  slots: [
    { kind: 'fixed', tier: 'COMMON', count: commons },
    { kind: 'rare', odds: { RARE: 100 } },
  ],
});
const UUID0 = '00000000-0000-4000-8000-000000000000';

interface Body {
  errorCode?: string;
  message?: unknown;
  details?: { missing?: { slot: string }[]; reason?: string };
  id?: string;
  name?: string;
  isActive?: boolean;
  imageUrl?: string | null;
  template?: { slots: unknown[] };
  cardCount?: number;
  cardCountByTier?: Record<string, number>;
  readiness?: { ready: boolean; missing: unknown[] };
  data?: Body[];
  meta?: { total: number; limit: number; page: number };
}

/** Story 22.4: admin CRUD of manual simulator sets (AC1-AC14) against the real (throw-away) database. */
describe('Admin manual simulator sets (e2e, Story 22.4)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let preexisting: string[];
  const savedMax = process.env.SIMULATOR_MAX_SETS;

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let n = 0;
  const uniq = (s = 's') => `${TAG}-${s}-${++n}`;
  const create = (body: object = {}) =>
    server()
      .post(BASE)
      .set(auth())
      .send({ name: uniq(), ...body });
  const mk = async (body: object = {}): Promise<string> =>
    ((await create(body).expect(201)).body as Body).id as string;
  const patch = (id: string, body: object) =>
    server().patch(`${BASE}/${id}`).set(auth()).send(body);
  const getSet = async (id: string) =>
    (await server().get(`${BASE}/${id}`).set(auth()).expect(200)).body as Body;
  const del = (id: string) => server().delete(`${BASE}/${id}`).set(auth());
  /** 20 cards per tier: ready for the default template. */
  const fill = async (setId: string, per = 20) => {
    await prisma.simulatorCard.createMany({
      data: PACK_TIERS.flatMap((t) =>
        Array.from({ length: per }, (_, i) => ({
          setId,
          name: `${t} ${i}`,
          rarityTier: t,
          number: `${t}-${i}`,
        })),
      ),
    });
  };
  /** `commons` COMMON cards + 1 RARE: ready for `tpl(n <= commons)`. */
  const mini = (setId: string, commons: number) =>
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
  const events = (setId: string) =>
    prisma.$queryRaw<
      {
        action: string;
        before: unknown;
        after: Record<string, unknown> | null;
        actorId: string | null;
        entityType: string;
      }[]
    >`SELECT "action","before","after","actorId","entityType" FROM "Audit_Events" WHERE "entityId" = ${setId} ORDER BY "seq"`;
  const version = async (id: string) =>
    (await prisma.simulatorSet.findUniqueOrThrow({ where: { id } })).version;

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
    const admin = await prisma.adminUser.upsert({
      where: { username: USER },
      create: { username: USER, email: EMAIL, passwordHash },
      update: { email: EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    if (savedMax === undefined) delete process.env.SIMULATOR_MAX_SETS;
    else process.env.SIMULATOR_MAX_SETS = savedMax;
    // restore: drop every set this suite created (cards cascade); pre-existing ones are untouched
    await prisma.simulatorSet.deleteMany({
      where: { id: { notIn: preexisting } },
    });
    await app.close();
  });

  describe('AC1/AC2/AC10: routes, shape, ids', () => {
    it('401 without a session on every route', async () => {
      await server().get(BASE).expect(401);
      await server().post(BASE).send({ name: 'x' }).expect(401);
      await server().get(`${BASE}/${UUID0}`).expect(401);
      await server().patch(`${BASE}/${UUID0}`).send({}).expect(401);
      await server().delete(`${BASE}/${UUID0}`).expect(401);
    });

    it('POST creates an INACTIVE set (isActive in the body is discarded) with the full SetDto', async () => {
      const r = await create({ isActive: true }).expect(201);
      const b = r.body as Body;
      expect(b.isActive).toBe(false);
      expect(b.imageUrl).toBeNull();
      expect(b.cardCount).toBe(0);
      expect(Object.keys(b.cardCountByTier ?? {}).sort()).toEqual(
        [...PACK_TIERS].sort(),
      );
      expect(b.readiness?.ready).toBe(false);
      expect((b.readiness?.missing ?? []).length).toBeGreaterThan(0);
      expect(b.template).toEqual(defaultPokemonTemplate());
      expect(await version(b.id as string)).toBe(1);
      expect(await getSet(b.id as string)).toMatchObject({
        id: b.id,
        name: b.name,
      });
    });

    it('GET list: {data, meta}, filters and limit bounds', async () => {
      const a = await mk();
      const act = await mk();
      await fill(act);
      await patch(act, { isActive: true }).expect(200);
      const all = (
        await server().get(`${BASE}?page=1&limit=100`).set(auth()).expect(200)
      ).body as Body;
      expect(all.meta).toMatchObject({ page: 1, limit: 100 });
      expect((all.data ?? []).some((s) => s.id === a)).toBe(true);
      const active = (
        await server()
          .get(`${BASE}?active=true&limit=100`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect((active.data ?? []).every((s) => s.isActive)).toBe(true);
      expect((active.data ?? []).some((s) => s.id === act)).toBe(true);
      const inactive = (
        await server()
          .get(`${BASE}?active=false&limit=100`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect((inactive.data ?? []).some((s) => s.id === act)).toBe(false);
      const q = (
        await server()
          .get(`${BASE}?q=${TAG.toUpperCase()}&limit=100`)
          .set(auth())
          .expect(200)
      ).body as Body;
      expect((q.data ?? []).length).toBeGreaterThanOrEqual(2);
      await server().get(`${BASE}?limit=101`).set(auth()).expect(400);
      await server().get(`${BASE}?limit=0`).set(auth()).expect(400);
      await server().get(`${BASE}?active=maybe`).set(auth()).expect(400);
      await patch(act, { isActive: false }).expect(200);
    });

    it('404 SIMULATOR_SET_NOT_FOUND and 400 for a non-uuid id', async () => {
      for (const r of [
        await server().get(`${BASE}/${UUID0}`).set(auth()),
        await patch(UUID0, { name: 'x' }),
        await del(UUID0),
      ]) {
        expect(r.status).toBe(404);
        expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_NOT_FOUND');
      }
      await server().get(`${BASE}/nope`).set(auth()).expect(400);
      await patch('nope', {}).expect(400);
      await del('nope').expect(400);
    });
  });

  describe('AC3/AC5: name, template and imageUrl validation', () => {
    it('name: required, trimmed, 1..120', async () => {
      await server().post(BASE).set(auth()).send({}).expect(400);
      for (const name of ['', '    ', 'x'.repeat(121), 5])
        await create({ name }).expect(400);
      const ok = (await create({ name: `  ${uniq('sp')}   x  ` }).expect(201))
        .body as Body;
      expect(ok.name).toMatch(/^[^ ].* x$/);
      expect(ok.name).not.toMatch(/ {2}/);
      await create({ name: 'y'.repeat(120) }).expect(201);
    });

    it('duplicate names ignoring case and spacing => 409 SIMULATOR_SET_NAME_TAKEN', async () => {
      const base = uniq('dup');
      await create({ name: `  ${base.toUpperCase()}  ` }).expect(201);
      const r = await create({ name: `${base.toLowerCase()}` }).expect(409);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_NAME_TAKEN');
      const spaced = uniq('Mi  Set');
      await create({ name: spaced }).expect(201);
      await create({ name: spaced.replace(/\s+/g, ' ').toLowerCase() }).expect(
        409,
      );
    });

    it('template: default is a materialized copy; invalid => 400 codes', async () => {
      const id = await mk({
        template: tpl(2),
      });
      expect((await getSet(id)).template?.slots).toHaveLength(2);
      const bad = await create({ template: { slots: [] } }).expect(400);
      expect((bad.body as Body).errorCode).toBe('SIMULATOR_CONFIG_INVALID');
      const sum = await create({
        template: { slots: [{ kind: 'rare', odds: { RARE: 50 } }] },
      }).expect(400);
      expect((sum.body as Body).errorCode).toBe('SIMULATOR_ODDS_INVALID_SUM');
      await create({ template: 'nope' }).expect(400);
      await create({ template: null }).expect(400);
    });

    it('imageUrl: own path / https ok; http, javascript:, //host, .., credentials, 301 chars => 400', async () => {
      for (const imageUrl of [
        '/uploads/public/simulator/a.png',
        '/uploads/public/landing/a.png',
        'https://cdn.example.com/a.png',
        null,
      ])
        await create({ imageUrl }).expect(201);
      for (const imageUrl of [
        'http://cdn.example.com/a.png',
        'javascript:alert(1)',
        '//evil.com/a.png',
        '/uploads/public/simulator/../x.png',
        'https://u:p@cdn.example.com/a.png',
        `https://e.com/${'a'.repeat(300)}`,
        42,
      ])
        await create({ imageUrl }).expect(400);
      const id = await mk({ imageUrl: 'https://cdn.example.com/a.png' });
      expect(
        ((await patch(id, { imageUrl: null }).expect(200)).body as Body)
          .imageUrl,
      ).toBeNull();
      await patch(id, { imageUrl: 'http://x.com/a.png' }).expect(400);
    });
  });

  describe('AC4: set limit', () => {
    it('SIMULATOR_SET_LIMIT 422 and 20 concurrent creations with 49 existing => exactly 1 success', async () => {
      const existing = await prisma.simulatorSet.count();
      process.env.SIMULATOR_MAX_SETS = String(existing + 3);
      for (let i = 0; i < 3; i++) await create().expect(201);
      const full = await create().expect(422);
      expect((full.body as Body).errorCode).toBe('SIMULATOR_SET_LIMIT');
      // free two slots, then race 20 creations for the remaining 1... (3 -> 2 free? delete 1 => 1 free)
      const ours = await prisma.simulatorSet.findMany({
        where: { id: { notIn: preexisting } },
        select: { id: true },
        take: 1,
      });
      await prisma.simulatorSet.delete({ where: { id: ours[0].id } });
      const results = await Promise.all(
        Array.from({ length: 20 }, () => create().then((r) => r.status)),
      );
      expect(results.filter((s) => s === 201)).toHaveLength(1);
      expect(results.filter((s) => s === 422)).toHaveLength(19);
      expect(await prisma.simulatorSet.count()).toBe(existing + 3);
      delete process.env.SIMULATOR_MAX_SETS;
    });
  });

  describe('AC8/AC9: activation, template edits, idempotence', () => {
    it('activating without cards => 422 SIMULATOR_SET_NOT_READY with missing; stays inactive', async () => {
      const id = await mk();
      const r = await patch(id, { isActive: true }).expect(422);
      const b = r.body as Body;
      expect(b.errorCode).toBe('SIMULATOR_SET_NOT_READY');
      expect((b.details?.missing ?? []).map((m) => m.slot)).toContain(
        'fixed:COMMON',
      );
      expect((await getSet(id)).isActive).toBe(false);
      expect(await version(id)).toBe(1);
      expect((await events(id)).map((e) => e.action)).toEqual([
        'SIMULATOR_SET_CREATED',
      ]);
    });

    it('activating a ready set works; idempotent re-activation / re-deactivation write nothing', async () => {
      const id = await mk();
      await fill(id);
      const on = (await patch(id, { isActive: true }).expect(200)).body as Body;
      expect(on.isActive).toBe(true);
      expect(on.readiness?.ready).toBe(true);
      const v = await version(id);
      expect(v).toBe(2);
      await patch(id, { isActive: true }).expect(200);
      await patch(id, {}).expect(200);
      expect(await version(id)).toBe(v);
      await patch(id, { isActive: false }).expect(200);
      await patch(id, { isActive: false }).expect(200);
      expect(await version(id)).toBe(v + 1);
      expect((await events(id)).map((e) => e.action)).toEqual([
        'SIMULATOR_SET_CREATED',
        'SIMULATOR_SET_ACTIVATED',
        'SIMULATOR_SET_DEACTIVATED',
      ]);
    });

    it('active set: heavier template => 422 and set stays active with the old template', async () => {
      const id = await mk({
        template: tpl(2),
      });
      await mini(id, 3);
      await patch(id, { isActive: true }).expect(200);
      const r = await patch(id, {
        template: tpl(5),
      }).expect(422);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_NOT_READY');
      const after = await getSet(id);
      expect(after.isActive).toBe(true);
      expect((after.template?.slots[0] as { count: number }).count).toBe(2);
      // lighter template is fine; inactive sets accept anything valid
      await patch(id, {
        template: tpl(1),
      }).expect(200);
      await patch(id, { isActive: false }).expect(200);
      await patch(id, {
        template: tpl(8),
      }).expect(200);
      await patch(id, { isActive: true }).expect(422);
    });

    it('name conflict => 409; editing own name case-only is fine; two changes => two events', async () => {
      const a = await mk({ name: uniq('na') });
      const bName = uniq('nb');
      await mk({ name: bName });
      const r = await patch(a, { name: bName.toUpperCase() }).expect(409);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_NAME_TAKEN');
      const own = (await getSet(a)).name as string;
      await patch(a, { name: own.toUpperCase() }).expect(200);
      await fill(a);
      const v = await version(a);
      await patch(a, { name: uniq('renamed'), isActive: true }).expect(200);
      expect(await version(a)).toBe(v + 1);
      const evs = (await events(a)).map((e) => e.action);
      expect(evs.slice(-2)).toEqual([
        'SIMULATOR_SET_UPDATED',
        'SIMULATOR_SET_ACTIVATED',
      ]);
      await patch(a, { isActive: false }).expect(200);
    });
  });

  describe('AC10: delete', () => {
    it('active => 409 SIMULATOR_SET_ACTIVE; inactive => 204 with cascade of cards', async () => {
      const id = await mk();
      await fill(id);
      await patch(id, { isActive: true }).expect(200);
      const r = await del(id).expect(409);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_ACTIVE');
      await patch(id, { isActive: false }).expect(200);
      expect(
        await prisma.simulatorCard.count({ where: { setId: id } }),
      ).toBeGreaterThan(0);
      await del(id).expect(204);
      expect(await prisma.simulatorCard.count({ where: { setId: id } })).toBe(
        0,
      );
      await server().get(`${BASE}/${id}`).set(auth()).expect(404);
      const last = (await events(id)).at(-1);
      expect(last?.action).toBe('SIMULATOR_SET_DELETED');
    });
  });

  describe('AC11: audit', () => {
    it('events carry actor, entityType and a personal-data-free payload; UPDATED holds a before/after diff', async () => {
      const name = uniq('aud');
      const id = ((await create({ name }).expect(201)).body as Body)
        .id as string;
      const renamed = uniq('aud2');
      await patch(id, { name: renamed }).expect(200);
      const evs = await events(id);
      expect(evs.map((e) => e.action)).toEqual([
        'SIMULATOR_SET_CREATED',
        'SIMULATOR_SET_UPDATED',
      ]);
      expect(
        evs.every(
          (e) => e.actorId === adminId && e.entityType === 'SimulatorSet',
        ),
      ).toBe(true);
      expect(evs[0].after).toEqual({ name, isActive: false, cardCount: 0 });
      expect(evs[1].before).toEqual({ name });
      expect(evs[1].after).toEqual({ name: renamed });
    });

    it('a set whose name looks like an id document is still audited (public text)', async () => {
      const id = (
        (await create({ name: 'V12345678' }).expect(201)).body as Body
      ).id as string;
      expect((await events(id))[0].after).toMatchObject({ name: 'V12345678' });
      await del(id).expect(204);
    });

    it('a rejected write leaves no event and no version change', async () => {
      const id = await mk();
      const before = (await events(id)).length;
      await patch(id, { isActive: true }).expect(422);
      expect((await events(id)).length).toBe(before);
    });
  });

  describe('AC12: pool cache', () => {
    it('clears after a committed write, not after a rolled-back one', async () => {
      const cache = app.get(SimulatorPoolCache);
      const spy = vi.spyOn(cache, 'clear');
      const id = await mk();
      expect(spy).toHaveBeenCalledTimes(1);
      await patch(id, { isActive: true }).expect(422);
      expect(spy).toHaveBeenCalledTimes(1);
      await patch(id, {}).expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await patch(id, { name: uniq('c') }).expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
      await del(id).expect(204);
      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockRestore();
    });
  });

  describe('AC6/AC13: locks and concurrency', () => {
    it('a set row locked by someone else => 409 SIMULATOR_SET_BUSY after the budget', async () => {
      const id = await mk();
      const u = new URL(process.env.DATABASE_URL as string);
      u.searchParams.delete('schema');
      const client = new pg.Client({ connectionString: u.toString() });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT 1 FROM "Simulator_Sets" WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const t0 = Date.now();
        const r = await patch(id, { name: uniq('busy') }).expect(409);
        expect((r.body as Body).errorCode).toBe('SIMULATOR_SET_BUSY');
        expect(Date.now() - t0).toBeLessThan(9_000);
        const d = await del(id).expect(409);
        expect((d.body as Body).errorCode).toBe('SIMULATOR_SET_BUSY');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
      await patch(id, { name: uniq('free') }).expect(200);
    }, 30_000);

    it('activate vs. heavier template: never active without sufficiency', async () => {
      for (let round = 0; round < 5; round++) {
        const id = await mk({
          template: tpl(2),
        });
        await mini(id, 2);
        const heavy = tpl(6);
        const rs = await Promise.all([
          patch(id, { isActive: true }),
          patch(id, { template: heavy }),
        ]);
        for (const r of rs) expect([200, 422]).toContain(r.status);
        const s = await getSet(id);
        if (s.isActive) expect(s.readiness?.ready).toBe(true);
      }
    });

    it('two PATCH of the name to the same value: one 200, one 409', async () => {
      const a = await mk();
      const b = await mk();
      const name = uniq('same');
      const rs = await Promise.all([patch(a, { name }), patch(b, { name })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('activate vs. delete: consistent outcome, never a 500', async () => {
      for (let round = 0; round < 5; round++) {
        const id = await mk();
        await fill(id);
        const [p, d] = await Promise.all([
          patch(id, { isActive: true }),
          del(id),
        ]);
        expect([200, 404]).toContain(p.status);
        expect([204, 409]).toContain(d.status);
        if (p.status === 404) expect(d.status).toBe(204);
        if (d.status === 204)
          expect(
            await prisma.simulatorSet.findUnique({ where: { id } }),
          ).toBeNull();
        else expect((await getSet(id)).isActive).toBe(true);
        await prisma.simulatorSet.updateMany({
          where: { id },
          data: { isActive: false },
        });
      }
    });
  });
});
