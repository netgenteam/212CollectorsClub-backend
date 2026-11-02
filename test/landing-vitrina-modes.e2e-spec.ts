import { createHash, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { Prisma } from './../src/generated/prisma/client.js';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { CatalogService } from './../src/catalog/catalog.service.js';
import { LandingContentService } from './../src/admin-landing/landing-content.service.js';
import { VitrinaScoringService } from './../src/vitrina/vitrina-scoring.service.js';
import { VitrinaSelectionService } from './../src/vitrina/vitrina-selection.service.js';
import { validBlock } from './../src/admin-landing/landing-blocks.fixtures.js';
import { restoreLanding, snapshotLanding } from './helpers/db-snapshot.js';
import {
  restoreVitrina,
  snapshotVitrina,
  type VitrinaSnapshot,
} from './helpers/vitrina-snapshot.js';

interface SchemaProp {
  enum?: string[];
  minimum?: number;
  maximum?: number;
}
type App = Parameters<typeof request>[0];
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-vitrina-18-9-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PASS = 'correct-horse-battery-staple-18-9';
const LANDING = '/api/v1/admin/landing-content';
const VIT = '/api/v1/admin/vitrina';
const VIT_ROW = { section: 'home', key: 'vitrina' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PublicProduct {
  id: string;
  name: string;
  inStock: boolean;
}
interface VitrinaValue {
  mode?: string;
  size?: number;
  productIds: string[];
  products: PublicProduct[];
  vitrina?: {
    mode: string;
    size: number;
    computedAt: string | null;
    items: { productId: string; source: string; reason: string | null }[];
  };
}

/**
 * Story 18.9 (AD-85): Home vitrina MANUAL/AUTO/MIXED over the persisted
 * ranking, draft vs published, live availability, fallback, query budget,
 * concurrency and the PUT algorithm lock wait. The ranking is a controlled
 * run inserted by the suite; only the `home/vitrina` row and the four Vitrina
 * tables are touched, and both are restored byte-faithfully.
 */
describe('Landing vitrina modes (e2e, Story 18.9)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let scoring: VitrinaScoringService;
  let catalog: CatalogService;
  let token: string;
  let adminId: string;
  let categoryId: string;
  let savedVit: VitrinaSnapshot;
  let savedRow: Awaited<ReturnType<typeof snapshotLanding>>;
  let hashRowBefore: string;
  let hashOthersBefore: string;
  let swagger: {
    components: {
      schemas: Record<string, { properties: Record<string, SchemaProp> }>;
    };
  };
  const productIds: string[] = [];
  const P: Record<string, string> = {};

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const hashRow = async () =>
    sha(
      JSON.stringify(
        await sql(
          `SELECT to_jsonb(t)::text AS j FROM "Landing_Config_Entries" t
           WHERE section='home' AND key='vitrina'`,
        ),
      ),
    );
  const hashOthers = async () =>
    sha(
      JSON.stringify(
        await sql(
          `SELECT to_jsonb(t)::text AS j FROM "Landing_Config_Entries" t
           WHERE NOT (section='home' AND key='vitrina') ORDER BY section, key`,
        ),
      ),
    );

  const mkProduct = async (
    key: string,
    o: { stock?: number; isActive?: boolean } = {},
  ) => {
    const p = await prisma.product.create({
      data: {
        name: `Vm${TAG} ${key}`,
        slug: `vm${TAG}-${key}`.toLowerCase(),
        description: 'Created by e2e 18.9.',
        franchise: 'POKEMON',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '10.00',
        stock: o.stock ?? 50,
        heldQty: 0,
        isActive: o.isActive ?? true,
        categoryId,
      },
    });
    productIds.push(p.id);
    P[key] = p.id;
    return p.id;
  };

  /** Installs a controlled current run (A0..A9 ranks 1..10) and returns its id. */
  const installRun = async (keys: string[]) => {
    const run = await prisma.productScoreRun.create({
      data: { mode: 'RANKED', config: {}, salesCount: 99, durationMs: 1 },
    });
    await prisma.productScore.createMany({
      data: keys.map((k, i) => ({
        runId: run.id,
        productId: P[k],
        rank: i + 1,
        score: (100 - i).toFixed(4),
        components: { scarcityFactor: 1 },
        reason: i === 0 ? 'TOP_SALES' : i === 1 ? 'NEW' : null,
      })),
    });
    await sql(
      `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = $1::uuid WHERE id='default'`,
      [run.id],
    );
    return run;
  };
  const clearRunPointer = () =>
    sql(
      `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = NULL WHERE id='default'`,
    );

  const block = (ids: string[], extra: Record<string, unknown> = {}) => ({
    ...validBlock('vitrina', ids),
    ...extra,
  });
  const putDraft = (body: unknown) =>
    server()
      .put(`${LANDING}/blocks/vitrina`)
      .set(auth())
      .send(body as object);
  const publish = () =>
    server().post(`${LANDING}/blocks/vitrina/publish`).set(auth());
  const discard = () =>
    server().delete(`${LANDING}/blocks/vitrina/draft`).set(auth());
  const publicRes = async () =>
    (
      (await server().get('/api/v1/landing-content').expect(200)).body as {
        home?: { vitrina?: { value: VitrinaValue; updatedAt: string } };
      }
    ).home?.vitrina;
  const publicVit = async () => (await publicRes())?.value;
  const draftVit = async () =>
    (
      (await server().get(`${LANDING}/draft`).set(auth()).expect(200)).body as {
        blocks: { vitrina?: VitrinaValue };
      }
    ).blocks.vitrina;
  const idsOf = (v?: VitrinaValue) => (v?.products ?? []).map((p) => p.id);
  const A = (...ks: string[]) => ks.map((k) => P[k]);

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
    swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    ) as unknown as typeof swagger;
    await app.init();
    prisma = app.get(PrismaService);
    scoring = app.get(VitrinaScoringService);
    catalog = app.get(CatalogService);

    // Snapshot BEFORE touching anything; the vitrina row is the only landing
    // row this suite writes, every other row must stay byte-identical.
    savedVit = await snapshotVitrina(sql);
    savedRow = await snapshotLanding(prisma, VIT_ROW);
    hashRowBefore = await hashRow();
    hashOthersBefore = await hashOthers();
    categoryId = (await prisma.category.findFirstOrThrow()).id;

    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: EMAIL,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    for (let i = 0; i < 10; i++) await mkProduct(`A${i}`);
    for (const k of ['M1', 'M2', 'M3', 'SOLD', 'GONE', 'FLIP'])
      await mkProduct(k, { stock: k === 'SOLD' ? 0 : 50 });
    await mkProduct('INACT', { isActive: false });
    await installRun(Array.from({ length: 10 }, (_, i) => `A${i}`));
  });

  beforeEach(async () => {
    await prisma.landingConfigEntry.deleteMany({ where: VIT_ROW });
  });

  afterAll(async () => {
    await prisma.landingConfigEntry.deleteMany({ where: VIT_ROW });
    await restoreLanding(prisma, VIT_ROW, savedRow);
    await prisma.productScore.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await restoreVitrina(sql, savedVit);
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    // Faithful restore: real vitrina row and every other landing row intact.
    expect(await hashRow()).toBe(hashRowBefore);
    expect(await hashOthers()).toBe(hashOthersBefore);
    expect(JSON.stringify(await snapshotVitrina(sql))).toBe(
      JSON.stringify(savedVit),
    );
    await app.close();
  });

  describe('AC1: DTO validation and Swagger', () => {
    const errPaths = (body: unknown) =>
      (
        (body as { details: { errors: { path: string }[] } }).details?.errors ??
        []
      ).map((e) => e.path);

    it('invalid mode / size / empty MANUAL => 400 LANDING_BLOCK_INVALID', async () => {
      const bad: [Record<string, unknown>, string[], string][] = [
        [block(A('A0'), { mode: 'RANDOM' }), A('A0'), 'mode'],
        [block(A('A0'), { mode: 'AUTO', size: 3 }), A('A0'), 'size'],
        [block(A('A0'), { mode: 'AUTO', size: 13 }), A('A0'), 'size'],
        [block(A('A0'), { mode: 'AUTO', size: 8.5 }), A('A0'), 'size'],
        [block(A('A0'), { size: '8' }), A('A0'), 'size'],
        [block([], { mode: 'MANUAL' }), [], 'productIds'],
      ];
      for (const [body, , path] of bad) {
        const res = await putDraft(body).expect(400);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'LANDING_BLOCK_INVALID',
        );
        expect(errPaths(res.body)).toContain(path);
      }
      const noMode = block([]);
      delete noMode.mode;
      await putDraft(noMode).expect(400);
      expect(
        (
          await sql(
            `SELECT 1 FROM "Landing_Config_Entries" WHERE section='home' AND key='vitrina'`,
          )
        ).length,
      ).toBe(0);
    });

    it('valid combos are accepted (AUTO/MIXED may have empty productIds); publish validates the same stored draft', async () => {
      await putDraft(block([], { mode: 'AUTO', size: 4 })).expect(200);
      await putDraft(block([], { mode: 'MIXED', size: 12 })).expect(200);
      await putDraft(block(A('A0'), { mode: 'MANUAL', size: 6 })).expect(200);
      await publish().expect(200);
      const v = await publicVit();
      expect(v?.mode).toBe('MANUAL');
      expect(v?.size).toBe(6);
    });

    it('Swagger exposes mode (enum) and size (4..12) on VitrinaBlockDto', () => {
      const props = swagger.components.schemas.VitrinaBlockDto.properties;
      expect(props.mode.enum).toEqual(['MANUAL', 'AUTO', 'MIXED']);
      expect(props.size.minimum).toBe(4);
      expect(props.size.maximum).toBe(12);
    });
  });

  describe('AC2/AC3: legacy content is MANUAL, byte for byte', () => {
    it('published value without mode => payload identical to the pre-18.9 computation', async () => {
      const legacy = validBlock(
        'vitrina',
        A('M3', 'M1', 'SOLD', 'INACT', 'M2'),
      );
      await prisma.landingConfigEntry.create({
        data: {
          ...VIT_ROW,
          valueType: 'json',
          value: legacy as Prisma.InputJsonObject,
          publishedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const res = await publicRes();
      // Previous implementation, inlined: {...value, products: inStock only},
      // over the value exactly as Postgres returns it (jsonb key order).
      const stored = (
        await prisma.landingConfigEntry.findFirstOrThrow({ where: VIT_ROW })
      ).value as Record<string, unknown>;
      const items = await catalog.findListItemsByIds(
        legacy.productIds as string[],
      );
      const expected = { ...stored, products: items.filter((p) => p.inStock) };
      expect(JSON.stringify(res?.value)).toBe(JSON.stringify(expected));
      expect(idsOf(res?.value)).toEqual(A('M3', 'M1', 'M2'));
      expect(res?.value && 'vitrina' in res.value).toBe(false);
      expect(res?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('explicit MANUAL ignores the ranking and size', async () => {
      await putDraft(block(A('M2', 'M1'), { mode: 'MANUAL', size: 12 })).expect(
        200,
      );
      await publish().expect(200);
      const v = await publicVit();
      expect(idsOf(v)).toEqual(A('M2', 'M1'));
      expect(v?.vitrina).toBeUndefined();
    });
  });

  describe('AC4/AC5: resolution', () => {
    it('MIXED, 3 pinned + size 8 => pinned in order, then 5 algorithmic, no duplicates (a pinned one also ranked)', async () => {
      // A1 is pinned AND rank 2: must appear once, as pinned.
      await putDraft(
        block(A('M3', 'A1', 'M1'), { mode: 'MIXED', size: 8 }),
      ).expect(200);
      await publish().expect(200);
      const v = await publicVit();
      const ids = idsOf(v);
      expect(ids).toHaveLength(8);
      expect(ids.slice(0, 3)).toEqual(A('M3', 'A1', 'M1'));
      expect(ids.slice(3)).toEqual(A('A0', 'A2', 'A3', 'A4', 'A5'));
      expect(new Set(ids).size).toBe(8);
      expect(v?.vitrina?.mode).toBe('MIXED');
      expect(v?.vitrina?.size).toBe(8);
      expect(v?.vitrina?.items.map((i) => i.productId)).toEqual(ids);
      expect(v?.vitrina?.items.map((i) => i.source)).toEqual([
        'pinned',
        'pinned',
        'pinned',
        'auto',
        'auto',
        'auto',
        'auto',
        'auto',
      ]);
      // reason is the stable key of the ranking row, passed through.
      expect(v?.vitrina?.items.find((i) => i.productId === P.A0)?.reason).toBe(
        'TOP_SALES',
      );
      expect(v?.vitrina?.items.find((i) => i.productId === P.A1)?.reason).toBe(
        'NEW',
      );
      expect(
        v?.vitrina?.items.find((i) => i.productId === P.M3)?.reason,
      ).toBeNull();
      const run = await sql(
        `SELECT r."computedAt" FROM "Product_Score_Runs" r JOIN "Vitrina_Algorithm_Settings" s ON s."currentRunId"=r.id`,
      );
      expect(v?.vitrina?.computedAt).toBe(
        (run[0].computedAt as Date).toISOString(),
      );
      // Same product DTO as MANUAL (extra fields only live under `vitrina`).
      expect(Object.keys(v!.products[0]).sort()).toEqual(
        Object.keys((await catalog.findListItemsByIds([P.M3]))[0]).sort(),
      );
    });

    it('AUTO ignores productIds', async () => {
      await putDraft(block(A('M1', 'M2'), { mode: 'AUTO', size: 4 })).expect(
        200,
      );
      await publish().expect(200);
      const v = await publicVit();
      expect(idsOf(v)).toEqual(A('A0', 'A1', 'A2', 'A3'));
      expect(v?.vitrina?.items.every((i) => i.source === 'auto')).toBe(true);
    });

    it('sold-out / deactivated products vanish live, without recompute; unavailable pinned is always omitted', async () => {
      await putDraft(
        block(A('SOLD', 'M1', 'INACT'), { mode: 'MIXED', size: 5 }),
      ).expect(200);
      await publish().expect(200);
      expect(idsOf(await publicVit())).toEqual(A('M1', 'A0', 'A1', 'A2', 'A3'));

      await prisma.product.update({ where: { id: P.A0 }, data: { stock: 0 } });
      await prisma.product.update({
        where: { id: P.A2 },
        data: { isActive: false },
      });
      try {
        const live = await publicVit();
        expect(idsOf(live)).toEqual(A('M1', 'A1', 'A3', 'A4', 'A5'));
        expect(idsOf(await draftVit())).toEqual(idsOf(live));
      } finally {
        await prisma.product.update({
          where: { id: P.A0 },
          data: { stock: 50 },
        });
        await prisma.product.update({
          where: { id: P.A2 },
          data: { isActive: true },
        });
      }
      // heldQty counts as unavailable too.
      await prisma.product.update({
        where: { id: P.A0 },
        data: { heldQty: 50 },
      });
      try {
        expect(idsOf(await publicVit())).not.toContain(P.A0);
      } finally {
        await prisma.product.update({
          where: { id: P.A0 },
          data: { heldQty: 0 },
        });
      }
    });

    it('size caps the list and extra pinned beyond size are cut', async () => {
      await putDraft(
        block(A('M1', 'M2', 'M3', 'A9', 'A8'), { mode: 'MIXED', size: 4 }),
      ).expect(200);
      await publish().expect(200);
      expect(idsOf(await publicVit())).toEqual(A('M1', 'M2', 'M3', 'A9'));
    });
  });

  describe('AC5: fallback without ranking never 5xx', () => {
    afterEach(async () => {
      await installRun(Array.from({ length: 10 }, (_, i) => `A${i}`));
    });

    it('no current run: MIXED => only pinned, AUTO => products [] (200)', async () => {
      await clearRunPointer();
      await putDraft(
        block(A('M2', 'SOLD', 'M1'), { mode: 'MIXED', size: 8 }),
      ).expect(200);
      await publish().expect(200);
      const mixed = await publicVit();
      expect(idsOf(mixed)).toEqual(A('M2', 'M1'));
      expect(mixed?.vitrina?.computedAt).toBeNull();

      await putDraft(block(A('M1'), { mode: 'AUTO', size: 8 })).expect(200);
      await publish().expect(200);
      const auto = await publicVit();
      expect(auto?.products).toEqual([]);
      expect(auto?.vitrina).toMatchObject({ mode: 'AUTO', items: [] });
      expect((await draftVit())?.products).toEqual([]);
    });

    it('current run with zero scores behaves the same', async () => {
      const run = await prisma.productScoreRun.create({
        data: { mode: 'FALLBACK', config: {}, salesCount: 0, durationMs: 1 },
      });
      await sql(
        `UPDATE "Vitrina_Algorithm_Settings" SET "currentRunId" = $1::uuid WHERE id='default'`,
        [run.id],
      );
      await putDraft(block(A('M1'), { mode: 'MIXED', size: 8 })).expect(200);
      await publish().expect(200);
      expect(idsOf(await publicVit())).toEqual(A('M1'));
      await putDraft(block([], { mode: 'AUTO' })).expect(200);
      await publish().expect(200);
      expect(await publicVit()).toMatchObject({ products: [] });
    });
  });

  describe('AC6: draft vs published, same ranking', () => {
    it('draft AUTO vs published MANUAL respect each version; discard returns to published', async () => {
      await putDraft(block(A('M1', 'M2'), { mode: 'MANUAL' })).expect(200);
      await publish().expect(200);
      await putDraft(block(A('M3'), { mode: 'AUTO', size: 5 })).expect(200);

      const pub = await publicVit();
      expect(idsOf(pub)).toEqual(A('M1', 'M2'));
      expect(pub?.vitrina).toBeUndefined();
      const draft = await draftVit();
      expect(idsOf(draft)).toEqual(A('A0', 'A1', 'A2', 'A3', 'A4'));
      expect(draft?.vitrina?.mode).toBe('AUTO');

      await discard().expect(204);
      expect(idsOf(await draftVit())).toEqual(A('M1', 'M2'));
    });

    it('both versions use the same current run (computedAt) and the preview agrees', async () => {
      await putDraft(block(A('M1'), { mode: 'MIXED', size: 6 })).expect(200);
      await publish().expect(200);
      await putDraft(block(A('M2'), { mode: 'MIXED', size: 6 })).expect(200);
      const pub = await publicVit();
      const draft = await draftVit();
      expect(pub?.vitrina?.computedAt).toBe(draft?.vitrina?.computedAt);
      expect(pub?.vitrina?.computedAt).not.toBeNull();

      for (const [v, pinned] of [
        [pub, P.M1],
        [draft, P.M2],
      ] as const) {
        const prev = await server()
          .get(`${VIT}/preview`)
          .query({ mode: 'MIXED', size: 6, pinned })
          .set(auth())
          .expect(200);
        const body = prev.body as {
          computedAt: string;
          items: Record<string, unknown>[];
        };
        expect(body.items.map((i) => i.productId)).toEqual(idsOf(v));
        expect(body.computedAt).toBe(v?.vitrina?.computedAt);
        expect(body.items.every((i) => !('product' in i))).toBe(true);
      }
    });
  });

  describe('AC4: query budget (no N+1)', () => {
    /** Counting view over the real client; the app's own client is untouched. */
    const counting = (calls: string[]) => {
      const wrapFns = <T extends object>(obj: T, prefix: string): T =>
        new Proxy(obj, {
          get(target, key) {
            const v: unknown = Reflect.get(target, key, target);
            if (typeof v !== 'function') return v;
            return (...a: unknown[]) => {
              calls.push(`${prefix}${String(key)}`);
              return (v as (...x: unknown[]) => unknown).apply(target, a);
            };
          },
        });
      return new Proxy(prisma, {
        get(target, key) {
          const v: unknown = Reflect.get(target, key, target);
          if (typeof key === 'string' && key.startsWith('$'))
            return typeof v === 'function'
              ? (...a: unknown[]) => {
                  calls.push(key);
                  return (v as (...x: unknown[]) => unknown).apply(target, a);
                }
              : v;
          return v && typeof v === 'object' ? wrapFns(v, `${String(key)}.`) : v;
        },
      });
    };

    it('resolve issues at most 3 queries regardless of size / pinned count', async () => {
      for (const [size, pinned] of [
        [4, []],
        [12, A('M1', 'M2', 'M3', 'A9', 'A8', 'A7')],
      ] as const) {
        const calls: string[] = [];
        const p = counting(calls);
        const sel = new VitrinaSelectionService(p, new CatalogService(p));
        const r = await sel.resolve({
          mode: 'MIXED',
          size,
          pinned: [...pinned],
        });
        expect(r.items).toHaveLength(size);
        expect(calls.length).toBeLessThanOrEqual(3);
        expect(calls.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('expandVitrina (Home path) adds no queries beyond resolve', async () => {
      const calls: string[] = [];
      const p = counting(calls);
      const content = new LandingContentService(
        p,
        new CatalogService(p),
        new VitrinaSelectionService(p, new CatalogService(p)),
      );
      const out = await content.expandVitrina(
        block(A('M1'), { mode: 'MIXED', size: 8 }),
      );
      expect((out.products as unknown[]).length).toBe(8);
      expect(calls.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Concurrency', () => {
    it('Promise.all of PUT draft + publish + public GET => no 5xx, coherent final state', async () => {
      await putDraft(block(A('M1'), { mode: 'MIXED', size: 6 })).expect(200);
      const calls = [
        ...Array.from({ length: 4 }, (_, i) =>
          putDraft(block(A('M1', 'M2'), { mode: 'MIXED', size: 4 + i * 2 })),
        ),
        publish(),
        publish(),
        server().get('/api/v1/landing-content'),
        server().get(`${LANDING}/draft`).set(auth()),
      ];
      const res = await Promise.all(calls);
      for (const r of res) expect([200, 409]).toContain(r.status);
      expect(res.filter((r) => r.status >= 500)).toHaveLength(0);
      const v = await publicVit();
      expect(v?.vitrina?.mode).toBe('MIXED');
      expect(idsOf(v)).toHaveLength(v!.vitrina!.size);
    });
  });

  describe('Extra (18.8 QA): PUT /admin/vitrina/algorithm behind a long recompute', () => {
    it("waits for the lock past Prisma's 5 s default and answers 200 (no 500)", async () => {
      const algo = (
        await server().get(`${VIT}/algorithm`).set(auth()).expect(200)
      ).body as Record<string, number>;
      const body = {
        wSales: algo.wSales,
        wRevenue: algo.wRevenue,
        wVelocity: algo.wVelocity,
        wInterest: algo.wInterest,
        wNovelty: algo.wNovelty,
        halfLifeDays: algo.halfLifeDays,
        windowDays: algo.windowDays,
        noveltyDays: algo.noveltyDays,
        maxPerFranchise: algo.maxPerFranchise,
        mmrLambda: algo.mmrLambda,
        priorM: algo.priorM,
      };
      const spy = vi
        .spyOn(
          scoring as unknown as { beforePointerSwap: () => Promise<void> },
          'beforePointerSwap',
        )
        .mockImplementation(async () => {
          await sleep(6500);
        });
      try {
        const slow = server().post(`${VIT}/recompute`).set(auth());
        const slowDone = Promise.resolve(slow).then((res) => res.status);
        // Wait until the recompute is inside its transaction, holding the
        // settings row FOR UPDATE (it reaches the seam only after locking).
        for (let i = 0; i < 100 && spy.mock.calls.length === 0; i++)
          await sleep(100);
        expect(spy.mock.calls.length).toBe(1);
        console.log(
          'DBG',
          JSON.stringify(
            await sql(
              `SELECT xmax::text, ctid::text FROM "Vitrina_Algorithm_Settings"`,
            ),
          ),
          JSON.stringify(await sql(`SELECT txid_current()::text t`)),
        );
        const t0 = Date.now();
        const put = await server()
          .put(`${VIT}/algorithm`)
          .set(auth())
          .send(body);
        expect(put.status).toBe(200);
        expect(Date.now() - t0).toBeGreaterThan(5000);
        expect(await slowDone).toBe(200);
      } finally {
        spy.mockRestore();
      }
    }, 40_000);
  });
});
