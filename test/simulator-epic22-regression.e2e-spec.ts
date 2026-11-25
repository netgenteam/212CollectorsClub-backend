import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { evaluateReadiness } from './../src/simulator/manual/readiness.js';
import { PACK_TIERS } from './../src/simulator/pack-tiers.js';
import {
  MIN_TIERS,
  cleanManualSets,
  seedManualSet,
} from './helpers/simulator-seed.js';

const USER = 'e2e-admin-story-22-9-reg';
const EMAIL = 'e2e-admin-story-22-9-reg@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-9-reg';
const BASE = '/api/v1/admin/simulator/manual-sets';
const PREFIX = `e2e229-${Date.now()}`;
const ROUNDS = 6;

/** Story 22.9 (AC4): real concurrency (`Promise.all`, real database) over the manual simulator invariants. */
describe('Simulator Epic 22 concurrency regression (e2e, Story 22.9 AC4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let n = 0;
  let url: string;
  const server = () => request(url);
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const name = (s: string) => `${PREFIX}-${s}-${++n}`;
  const savedCards = process.env.SIMULATOR_MAX_CARDS_PER_SET;
  const savedRate = process.env.SIMULATOR_RATE_LIMIT_PER_MIN;

  /** The DB invariant: an active set can always fill its own template. */
  const assertInvariant = async (id: string) => {
    const set = await prisma.simulatorSet.findUniqueOrThrow({ where: { id } });
    const groups = await prisma.simulatorCard.groupBy({
      by: ['rarityTier'],
      where: { setId: id },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      groups.map((g) => [g.rarityTier, g._count._all]),
    );
    const r = evaluateReadiness(set.template, counts);
    if (set.isActive)
      expect(r, `active set ${id} must be ready`).toMatchObject({
        ready: true,
      });
  };

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    process.env.SIMULATOR_RATE_LIMIT_PER_MIN = '100000';
    prisma = app.get(PrismaService);
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
    if (savedCards === undefined)
      delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
    else process.env.SIMULATOR_MAX_CARDS_PER_SET = savedCards;
    if (savedRate === undefined)
      delete process.env.SIMULATOR_RATE_LIMIT_PER_MIN;
    else process.env.SIMULATOR_RATE_LIMIT_PER_MIN = savedRate;
    await cleanManualSets(prisma, PREFIX);
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  it('activate vs delete a critical card: never active without sufficiency', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { id, cardIds } = await seedManualSet(prisma, {
        name: name('act-del'),
        tiers: MIN_TIERS,
        isActive: false,
      });
      const hyper = await prisma.simulatorCard.findFirstOrThrow({
        where: { setId: id, rarityTier: 'HYPER_RARE' },
      });
      expect(cardIds.length).toBe(15);
      const [a, d] = await Promise.all([
        server().patch(`${BASE}/${id}`).set(auth()).send({ isActive: true }),
        server().delete(`${BASE}/${id}/cards/${hyper.id}`).set(auth()),
      ]);
      expect([200, 422]).toContain(a.status);
      expect([204, 422]).toContain(d.status);
      // serialised by the set row lock: at most one side wins when they conflict
      if (a.status === 200) expect(d.status).toBe(422);
      await assertInvariant(id);
    }
  });

  it('two imports that together exceed the cap: the cap holds', async () => {
    process.env.SIMULATOR_MAX_CARDS_PER_SET = '10';
    for (let i = 0; i < ROUNDS; i++) {
      const id = (
        (
          await server()
            .post(BASE)
            .set(auth())
            .send({ name: name('cap') })
            .expect(201)
        ).body as { id: string }
      ).id;
      const csv = (p: string) =>
        Buffer.from(
          'name,rarity,number\n' +
            Array.from(
              { length: 6 },
              (_, k) => `${p}${k},common,${p}${k}`,
            ).join('\n') +
            '\n',
        );
      const imp = (p: string) =>
        server()
          .post(`${BASE}/${id}/cards/import`)
          .set(auth())
          .attach('file', csv(p), {
            filename: `${p}.csv`,
            contentType: 'text/csv',
          });
      const rs = await Promise.all([imp('a'), imp('b')]);
      const codes = rs.map((r) => r.status).sort();
      expect(codes).toEqual([201, 422]);
      const loser = rs.find((r) => r.status === 422)!;
      expect((loser.body as { errorCode: string }).errorCode).toBe(
        'SIMULATOR_SET_CARD_LIMIT',
      );
      expect(await prisma.simulatorCard.count({ where: { setId: id } })).toBe(
        6,
      );
    }
  });

  it('activate vs edit the template: never active with a template the cards cannot fill', async () => {
    const harder = {
      slots: [
        { kind: 'fixed', tier: 'COMMON', count: 8 },
        { kind: 'rare', odds: { RARE: 100 } },
      ],
    };
    for (let i = 0; i < ROUNDS; i++) {
      const { id } = await seedManualSet(prisma, {
        name: name('act-tpl'),
        tiers: MIN_TIERS,
        isActive: false,
      });
      const [a, t] = await Promise.all([
        server().patch(`${BASE}/${id}`).set(auth()).send({ isActive: true }),
        server().patch(`${BASE}/${id}`).set(auth()).send({ template: harder }),
      ]);
      expect([200, 422]).toContain(a.status);
      expect([200, 422]).toContain(t.status);
      await assertInvariant(id);
    }
  });

  it('public open vs deactivate: always 200 or 404, never 500', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { id } = await seedManualSet(prisma, {
        name: name('open'),
        tiers: MIN_TIERS,
        isActive: true,
      });
      const opens = Array.from({ length: 12 }, () =>
        server().post('/api/v1/simulator/packs').send({ setId: id }),
      );
      const [, ...rs] = await Promise.all([
        server().patch(`${BASE}/${id}`).set(auth()).send({ isActive: false }),
        ...opens,
      ]);
      for (const r of rs) {
        expect([200, 404], `status ${r.status}`).toContain(r.status);
        if (r.status === 200)
          expect((r.body as { cards: unknown[] }).cards).toHaveLength(10);
      }
      // after the deactivation commits, the next open is a 404 at once
      await server()
        .post('/api/v1/simulator/packs')
        .send({ setId: id })
        .expect(404);
    }
  });

  it('the tier list used by the seeds is the 8 tiers of the contract', () => {
    expect(PACK_TIERS).toHaveLength(8);
  });
});
