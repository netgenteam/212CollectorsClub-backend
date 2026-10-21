import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface Cat {
  id: string;
  name: string;
  slug: string;
  type: string;
  dimension: string | null;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  _count?: { products: number };
}
interface ErrBody {
  errorCode?: string;
}

const TEST_USERNAME = 'e2e-admin-story-13-2';
const TEST_EMAIL = 'e2e-admin-story-13-2@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-13b2';
const PREFIX = 'e2e132-';

/**
 * Story 13.2 (FR-46, FR-48; AD-33..35). Full-stack e2e for the category
 * taxonomy: merged-state validation, cycles/depth (sequential and
 * concurrent), escaped search, filters, counts, delete policy and races.
 * All rows created here use the `e2e132-` slug prefix and are removed after
 * each test.
 */
describe('Admin categories taxonomy (e2e, Story 13.2)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    accessToken = (loginRes.body as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.category.updateMany({
      where: { slug: { startsWith: PREFIX } },
      data: { parentId: null },
    });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function mk(
    extra: Record<string, unknown> = {},
    suffix = randomUUID().slice(0, 8),
  ): Promise<Cat> {
    const res = await authed('post', '/api/v1/admin/categories')
      .send({ name: `E2E ${suffix}`, slug: `${PREFIX}${suffix}`, ...extra })
      .expect(201);
    return res.body as Cat;
  }

  const sub = (parentId: string, extra: Record<string, unknown> = {}) =>
    mk({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId, ...extra });

  const err = (body: unknown) => (body as ErrBody).errorCode;

  async function mkProduct(categoryId: string): Promise<string> {
    const p = await prisma.product.create({
      data: {
        name: 'E2E product',
        slug: `${PREFIX}p-${randomUUID().slice(0, 8)}`,
        description: 'x',
        franchise: 'POKEMON',
        productType: 'BOOSTER_PACK',
        rarity: 'COMMON',
        priceUsd: 1,
        stock: 1,
        categoryId,
      },
    });
    return p.id;
  }

  describe('AC1 migration / AC2 contract', () => {
    it('schema: CHECK constraint, FK RESTRICT, indexes exist', async () => {
      const checks = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE conname = 'Categories_root_no_dimension_parent_check'`;
      expect(checks).toHaveLength(1);
      const fk = await prisma.$queryRaw<{ confdeltype: string }[]>`
        SELECT confdeltype::text FROM pg_constraint WHERE conname = 'Categories_parentId_fkey'`;
      expect(fk[0].confdeltype).toBe('r');
      const idx = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'Categories'`;
      const names = idx.map((i) => i.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'Categories_parentId_idx',
          'Categories_dimension_isActive_idx',
        ]),
      );
      await expect(
        prisma.$executeRaw`INSERT INTO "Categories"(id,name,slug,"updatedAt",type,dimension) VALUES (gen_random_uuid(),'x',${PREFIX + 'chk'},now(),'ROOT','CUSTOM')`,
      ).rejects.toBeDefined();
    });

    it('POST {name, slug} only: 201, ROOT defaults, new fields present; seeded rows are ROOT', async () => {
      const c = await mk();
      expect(c).toMatchObject({
        type: 'ROOT',
        dimension: null,
        parentId: null,
        isActive: true,
        sortOrder: 0,
      });
      const seeded = await authed(
        'get',
        '/api/v1/admin/categories/dd848f24-aac0-4346-ae25-b672bb0d7e14',
      ).expect(200);
      expect(seeded.body).toMatchObject({
        type: 'ROOT',
        dimension: null,
        parentId: null,
        isActive: true,
        sortOrder: 0,
      });
    });

    it('public GET /categories keeps id,name,slug (13.3 only adds taxonomy fields)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);
      expect(Object.keys((res.body as Cat[])[0]).sort()).toEqual([
        'dimension',
        'id',
        'isActive',
        'name',
        'parentId',
        'slug',
        'sortOrder',
        'type',
      ]);
    });
  });

  describe('AC3 DTO validation / AC4 merged state / AC5 ROOT switch', () => {
    it('creates a SUBCATEGORY with dimension under a ROOT and under a SUBCATEGORY; PATCH is partial', async () => {
      const root = await mk();
      const s1 = await sub(root.id, { sortOrder: 5, isActive: false });
      expect(s1).toMatchObject({
        type: 'SUBCATEGORY',
        dimension: 'CUSTOM',
        parentId: root.id,
        sortOrder: 5,
        isActive: false,
      });
      const s2 = await sub(s1.id);
      expect(s2.parentId).toBe(s1.id);
      const patched = await authed('patch', `/api/v1/admin/categories/${s2.id}`)
        .send({ sortOrder: 9 })
        .expect(200);
      expect(patched.body).toMatchObject({
        sortOrder: 9,
        parentId: s1.id,
        dimension: 'CUSTOM',
        slug: s2.slug,
      });
    });

    it.each([
      [{ sortOrder: -1 }],
      [{ sortOrder: 100001 }],
      [{ sortOrder: 1.5 }],
      [{ isActive: 'yes' }],
      [{ isActive: null }],
      [{ type: 'NOPE' }],
      [{ dimension: 'NOPE' }],
      [{ parentId: 'not-a-uuid' }],
    ])('400 for invalid body %j (POST and PATCH)', async (bad) => {
      await authed('post', '/api/v1/admin/categories')
        .send({ name: 'x', slug: `${PREFIX}bad`, ...bad })
        .expect(400);
      const c = await mk();
      await authed('patch', `/api/v1/admin/categories/${c.id}`)
        .send(bad)
        .expect(400);
    });

    it('ROOT + dimension / ROOT + parentId / SUBCATEGORY w/o dimension / unknown parent => 400 with codes and nothing persisted', async () => {
      const root = await mk();
      const slug = `${PREFIX}nope`;
      const post = (b: Record<string, unknown>) =>
        authed('post', '/api/v1/admin/categories')
          .send({ name: 'n', slug, ...b })
          .expect(400);
      expect(err((await post({ dimension: 'CUSTOM' })).body)).toBe(
        'CATEGORY_DIMENSION_INVALID',
      );
      expect(err((await post({ parentId: root.id })).body)).toBe(
        'CATEGORY_PARENT_INVALID',
      );
      expect(err((await post({ type: 'SUBCATEGORY' })).body)).toBe(
        'CATEGORY_DIMENSION_INVALID',
      );
      expect(
        err(
          (
            await post({
              type: 'SUBCATEGORY',
              dimension: 'CUSTOM',
              parentId: randomUUID(),
            })
          ).body,
        ),
      ).toBe('CATEGORY_PARENT_INVALID');
      expect(await prisma.category.count({ where: { slug } })).toBe(0);

      // PATCH merged state: dimension on a ROOT row.
      const res = await authed('patch', `/api/v1/admin/categories/${root.id}`)
        .send({ dimension: 'CUSTOM' })
        .expect(400);
      expect(err(res.body)).toBe('CATEGORY_DIMENSION_INVALID');
      const after = await authed(
        'get',
        `/api/v1/admin/categories/${root.id}`,
      ).expect(200);
      expect((after.body as Cat).dimension).toBeNull();
    });

    it('SUBCATEGORY -> ROOT needs explicit nulls; with both null it clears them', async () => {
      const root = await mk();
      const s = await sub(root.id);
      const url = `/api/v1/admin/categories/${s.id}`;
      await authed('patch', url).send({ type: 'ROOT' }).expect(400);
      await authed('patch', url)
        .send({ type: 'ROOT', dimension: null })
        .expect(400);
      await authed('patch', url)
        .send({ type: 'ROOT', parentId: null })
        .expect(400);
      const ok = await authed('patch', url)
        .send({ type: 'ROOT', dimension: null, parentId: null })
        .expect(200);
      expect(ok.body).toMatchObject({
        type: 'ROOT',
        dimension: null,
        parentId: null,
      });
    });
  });

  describe('AC6 cycles / AC7 depth', () => {
    it('self-parent and descendant-parent => 400 CATEGORY_CYCLE, nothing changes', async () => {
      const a = await mk();
      const b = await sub(a.id);
      const c = await sub(b.id);
      // A is ROOT: give it type SUBCATEGORY to be able to hold a parent.
      const selfRes = await authed('patch', `/api/v1/admin/categories/${a.id}`)
        .send({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId: a.id })
        .expect(400);
      expect(err(selfRes.body)).toBe('CATEGORY_CYCLE');
      const cycRes = await authed('patch', `/api/v1/admin/categories/${a.id}`)
        .send({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId: c.id })
        .expect(400);
      expect(err(cycRes.body)).toBe('CATEGORY_CYCLE');
      const row = await prisma.category.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(row).toMatchObject({ type: 'ROOT', parentId: null });
    });

    it('depth 4 rejected on create and on subtree move; leaf to depth 3 allowed', async () => {
      const r = await mk();
      const s1 = await sub(r.id);
      const s2 = await sub(s1.id);
      const res = await authed('post', '/api/v1/admin/categories')
        .send({
          name: 'd4',
          slug: `${PREFIX}d4`,
          type: 'SUBCATEGORY',
          dimension: 'CUSTOM',
          parentId: s2.id,
        })
        .expect(400);
      expect(err(res.body)).toBe('CATEGORY_DEPTH_EXCEEDED');

      // Subtree T -> U (height 1) moved under s1 => depth(T)=3, U=4 => reject.
      const t = await mk();
      const u = await sub(t.id);
      expect(u.parentId).toBe(t.id);
      const tSub = await authed('patch', `/api/v1/admin/categories/${t.id}`)
        .send({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId: s1.id })
        .expect(400);
      expect(err(tSub.body)).toBe('CATEGORY_DEPTH_EXCEEDED');

      // Leaf to depth 3 succeeds.
      const leaf = await mk();
      await authed('patch', `/api/v1/admin/categories/${leaf.id}`)
        .send({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId: s2.id })
        .expect(400); // depth 4 (r>s1>s2>leaf)
      await authed('patch', `/api/v1/admin/categories/${leaf.id}`)
        .send({ type: 'SUBCATEGORY', dimension: 'CUSTOM', parentId: s1.id })
        .expect(200);
    });
  });

  describe('AC8 / AC9 concurrency', () => {
    it('concurrent PATCHes forming a cycle: exactly one wins, other 400 CATEGORY_CYCLE, never 500 (5 rounds)', async () => {
      for (let round = 0; round < 5; round++) {
        const root = await mk();
        const a = await sub(root.id);
        const b = await sub(root.id);
        const [r1, r2] = await Promise.all([
          authed('patch', `/api/v1/admin/categories/${a.id}`).send({
            parentId: b.id,
          }),
          authed('patch', `/api/v1/admin/categories/${b.id}`).send({
            parentId: a.id,
          }),
        ]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses).toEqual([200, 400]);
        const loser = r1.status === 400 ? r1 : r2;
        expect(err(loser.body)).toBe('CATEGORY_CYCLE');
        const rows = await prisma.category.findMany({
          where: { id: { in: [a.id, b.id] } },
        });
        // No cycle: at least one of them still hangs from root.
        expect(rows.some((r) => r.parentId === root.id)).toBe(true);
      }
    });

    it('concurrent moves that together exceed depth 3: tree never exceeds depth 3', async () => {
      for (let round = 0; round < 3; round++) {
        const r = await mk();
        const x = await sub(r.id); // depth 2
        const y = await mk(); // free ROOT
        const z = await mk();
        // y under x => depth 3; z under y (needs y as parent) would be 4.
        const [r1, r2] = await Promise.all([
          authed('patch', `/api/v1/admin/categories/${y.id}`).send({
            type: 'SUBCATEGORY',
            dimension: 'CUSTOM',
            parentId: x.id,
          }),
          authed('patch', `/api/v1/admin/categories/${z.id}`).send({
            type: 'SUBCATEGORY',
            dimension: 'CUSTOM',
            parentId: y.id,
          }),
        ]);
        expect([200, 400]).toContain(r1.status);
        expect([200, 400]).toContain(r2.status);
        for (const res of [r1, r2]) {
          if (res.status === 400) {
            expect(err(res.body)).toBe('CATEGORY_DEPTH_EXCEEDED');
          }
        }
        const depth = async (id: string): Promise<number> => {
          let d = 1;
          let cur = await prisma.category.findUniqueOrThrow({ where: { id } });
          while (cur.parentId) {
            d++;
            cur = await prisma.category.findUniqueOrThrow({
              where: { id: cur.parentId },
            });
            expect(d).toBeLessThanOrEqual(5);
          }
          return d;
        };
        expect(await depth(y.id)).toBeLessThanOrEqual(3);
        expect(await depth(z.id)).toBeLessThanOrEqual(3);
      }
    });

    it('concurrent creates under the same depth-2 parent: all rejected or consistent (depth never > 3)', async () => {
      const r = await mk();
      const s1 = await sub(r.id);
      const s2 = await sub(s1.id);
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          authed('post', '/api/v1/admin/categories').send({
            name: `c${i}`,
            slug: `${PREFIX}cc${i}`,
            type: 'SUBCATEGORY',
            dimension: 'CUSTOM',
            parentId: s2.id,
          }),
        ),
      );
      for (const res of results) {
        expect(res.status).toBe(400);
        expect(err(res.body)).toBe('CATEGORY_DEPTH_EXCEEDED');
      }
    });
  });

  describe('AC10 / AC11 / AC12 list, search, filters, counts', () => {
    it('search matches literally: %, _, backslash, injection string', async () => {
      const pct = await mk({ name: '100% Pure' }, 'pure');
      const thousand = await mk({ name: '1000 Cards' }, 'thou');
      const us = await mk({ name: 'a_b x' }, 'under');
      const other = await mk({ name: 'axb x' }, 'axb');
      const bs = await mk({ name: 'back\\slash' }, 'bsl');
      const list = async (qs: string) =>
        (
          (await authed('get', `/api/v1/admin/categories${qs}`).expect(200))
            .body as Cat[]
        ).map((c) => c.id);

      let ids = await list(`?search=${encodeURIComponent('100%')}`);
      expect(ids).toContain(pct.id);
      expect(ids).not.toContain(thousand.id);

      ids = await list(`?search=${encodeURIComponent('a_b')}`);
      expect(ids).toContain(us.id);
      expect(ids).not.toContain(other.id);

      ids = await list('?search=_');
      expect(ids).toContain(us.id);
      expect(ids).not.toContain(thousand.id);
      expect(ids).not.toContain(pct.id);

      ids = await list(`?search=${encodeURIComponent('\\')}`);
      expect(ids).toEqual([bs.id]);

      const inj = `'; DROP TABLE "Categories";--`;
      ids = await list(`?search=${encodeURIComponent(inj)}`);
      expect(ids).toEqual([]);
      expect(await prisma.category.count()).toBeGreaterThan(0);

      // case-insensitive on name and slug; q alias; search wins over q
      expect(await list(`?q=PURE`)).toContain(pct.id);
      expect(await list(`?search=${PREFIX.toUpperCase()}thou`)).toEqual([
        thousand.id,
      ]);
      ids = await list(`?search=pure&q=thou`);
      expect(ids).toContain(pct.id);
      expect(ids).not.toContain(thousand.id);

      await authed(
        'get',
        `/api/v1/admin/categories?search=${'x'.repeat(101)}`,
      ).expect(400);
    });

    it('filters type/dimension/isActive AND with search; invalid values 400; items carry new fields and _count', async () => {
      const root = await mk({ name: 'Filt root' }, 'froot');
      const on = await sub(root.id, {
        name: 'Filt on',
        dimension: 'FRANCHISE',
      });
      const off = await sub(root.id, {
        name: 'Filt off',
        dimension: 'FRANCHISE',
        isActive: false,
      });
      const get = async (qs: string) =>
        (await authed('get', `/api/v1/admin/categories?${qs}`).expect(200))
          .body as Cat[];
      let rows = await get(
        'search=filt&type=SUBCATEGORY&dimension=FRANCHISE&isActive=false',
      );
      expect(rows.map((r) => r.id)).toEqual([off.id]);
      rows = await get('search=filt&isActive=true');
      expect(rows.map((r) => r.id).sort()).toEqual([root.id, on.id].sort());
      rows = await get('search=filt&type=ROOT');
      expect(rows.map((r) => r.id)).toEqual([root.id]);
      expect(rows[0]).toMatchObject({
        type: 'ROOT',
        dimension: null,
        parentId: null,
        isActive: true,
        sortOrder: 0,
        _count: { products: 0 },
      });
      for (const bad of ['type=X', 'dimension=X', 'isActive=maybe']) {
        await authed('get', `/api/v1/admin/categories?${bad}`).expect(400);
      }
    });

    it('_count.products counts DISTINCT products; query count does not grow with rows', async () => {
      const a = await mk({}, 'cnt-a');
      await mkProduct(a.id);
      await mkProduct(a.id);
      const res = await authed(
        'get',
        `/api/v1/admin/categories/${a.id}`,
      ).expect(200);
      expect((res.body as Cat)._count).toEqual({ products: 2 });

      const raw = vi.spyOn(prisma, '$queryRaw');
      const many = vi.spyOn(prisma.category, 'findMany');
      await authed('get', '/api/v1/admin/categories?search=cnt-a').expect(200);
      const small = raw.mock.calls.length + many.mock.calls.length;
      for (let i = 0; i < 4; i++) await mk({}, `cnt-b${i}`);
      raw.mockClear();
      many.mockClear();
      const list = await authed(
        'get',
        '/api/v1/admin/categories?q=cnt-',
      ).expect(200);
      expect((list.body as Cat[]).length).toBe(5);
      const big = raw.mock.calls.length + many.mock.calls.length;
      expect(big).toBe(small);
      raw.mockRestore();
      many.mockRestore();
    });
  });

  describe('AC13 deactivate / AC14 delete / AC15 race / AC16 slug / AC17 auth', () => {
    it('isActive:false keeps products and children untouched (no cascade)', async () => {
      const root = await mk();
      const child = await sub(root.id);
      const pid = await mkProduct(root.id);
      const res = await authed('patch', `/api/v1/admin/categories/${root.id}`)
        .send({ isActive: false })
        .expect(200);
      expect((res.body as Cat).isActive).toBe(false);
      expect(
        (await prisma.category.findUniqueOrThrow({ where: { id: child.id } }))
          .isActive,
      ).toBe(true);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: pid } }))
          .categoryId,
      ).toBe(root.id);
    });

    it('delete: 409 CATEGORY_IN_USE with products, 409 CATEGORY_HAS_CHILDREN with children, 204 when free, 400/404 on bad ids', async () => {
      const withProduct = await mk();
      await mkProduct(withProduct.id);
      const r1 = await authed(
        'delete',
        `/api/v1/admin/categories/${withProduct.id}`,
      ).expect(409);
      expect(err(r1.body)).toBe('CATEGORY_IN_USE');

      const parent = await mk();
      const child = await sub(parent.id);
      const r2 = await authed(
        'delete',
        `/api/v1/admin/categories/${parent.id}`,
      ).expect(409);
      expect(err(r2.body)).toBe('CATEGORY_HAS_CHILDREN');

      await authed('delete', `/api/v1/admin/categories/${child.id}`).expect(
        204,
      );
      await authed('delete', `/api/v1/admin/categories/${parent.id}`).expect(
        204,
      );
      await authed('delete', '/api/v1/admin/categories/not-a-uuid').expect(400);
      await authed('delete', `/api/v1/admin/categories/${randomUUID()}`).expect(
        404,
      );
    });

    it('delete racing with child creation: never 500, never an orphan (several rounds)', async () => {
      for (let i = 0; i < 6; i++) {
        const parent = await mk();
        const [del, create] = await Promise.all([
          authed('delete', `/api/v1/admin/categories/${parent.id}`),
          authed('post', '/api/v1/admin/categories').send({
            name: 'race',
            slug: `${PREFIX}race${i}`,
            type: 'SUBCATEGORY',
            dimension: 'CUSTOM',
            parentId: parent.id,
          }),
        ]);
        expect(del.status).toBeLessThan(500);
        expect(create.status).toBeLessThan(500);
        if (del.status === 204) {
          expect(create.status).toBe(400);
          expect(err(create.body)).toBe('CATEGORY_PARENT_INVALID');
        } else {
          expect(del.status).toBe(409);
          expect(create.status).toBe(201);
        }
        const orphans = await prisma.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM "Categories" c LEFT JOIN "Categories" p ON p.id = c."parentId"
          WHERE c."parentId" IS NOT NULL AND p.id IS NULL`;
        expect(orphans).toEqual([]);
      }
    });

    it('duplicate slug on create and PATCH: 409 CATEGORY_SLUG_TAKEN', async () => {
      const a = await mk();
      const b = await mk();
      const c = await authed('post', '/api/v1/admin/categories')
        .send({ name: 'dup', slug: a.slug })
        .expect(409);
      expect(err(c.body)).toBe('CATEGORY_SLUG_TAKEN');
      const p = await authed('patch', `/api/v1/admin/categories/${b.id}`)
        .send({ slug: a.slug })
        .expect(409);
      expect(err(p.body)).toBe('CATEGORY_SLUG_TAKEN');
    });

    it('no token: 401 INVALID_ADMIN_TOKEN on list with search; public list still 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/categories?search=x')
        .expect(401);
      expect(err(res.body)).toBe('INVALID_ADMIN_TOKEN');
      await request(app.getHttpServer()).get('/api/v1/categories').expect(200);
    });
  });
});
