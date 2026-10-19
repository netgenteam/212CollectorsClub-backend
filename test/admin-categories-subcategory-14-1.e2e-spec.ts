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

const TEST_USERNAME = 'e2e-admin-story-14-1';
const TEST_EMAIL = 'e2e-admin-story-14-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-14b1';
const PREFIX = 'e2e141-';

/**
 * Story 14.1 (FR-54, FR-56; AD-41, AD-42). Optional dimension on
 * SUBCATEGORY, admin list parentId filter and deterministic ordering.
 * All rows created here use the `e2e141-` slug prefix and are removed after
 * each test.
 */
describe('Admin categories taxonomy (e2e, Story 14.1)', () => {
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

  const err = (body: unknown) => (body as ErrBody).errorCode;

  const list = async (qs: string) =>
    (await authed('get', `/api/v1/admin/categories${qs}`).expect(200))
      .body as Cat[];

  it('AC1: SUBCATEGORY + parentId without dimension => 201, dimension null', async () => {
    const root = await mk();
    const c = await mk({ type: 'SUBCATEGORY', parentId: root.id });
    expect(c.dimension).toBeNull();
    expect(c.parentId).toBe(root.id);
    const row = await prisma.category.findUnique({ where: { id: c.id } });
    expect(row?.dimension).toBeNull();
  });

  it('AC2: SUBCATEGORY with neither parentId nor dimension => 400; PATCH leaving that state => 400', async () => {
    const root = await mk();
    const res = await authed('post', '/api/v1/admin/categories')
      .send({ name: 'n', slug: `${PREFIX}bad`, type: 'SUBCATEGORY' })
      .expect(400);
    expect(err(res.body)).toBe('CATEGORY_DIMENSION_INVALID');
    const c = await mk({ type: 'SUBCATEGORY', parentId: root.id });
    const p = await authed('patch', `/api/v1/admin/categories/${c.id}`)
      .send({ parentId: null })
      .expect(400);
    expect(err(p.body)).toBe('CATEGORY_DIMENSION_INVALID');
  });

  it('AC3: CUSTOM + parentId still 201; ROOT rules, cycle and slug uniqueness unchanged', async () => {
    const root = await mk();
    const c = await mk({
      type: 'SUBCATEGORY',
      dimension: 'CUSTOM',
      parentId: root.id,
    });
    expect(c.dimension).toBe('CUSTOM');
    await authed('post', '/api/v1/admin/categories')
      .send({ name: 'n', slug: `${PREFIX}r`, dimension: 'CUSTOM' })
      .expect(400);
    await authed('post', '/api/v1/admin/categories')
      .send({ name: 'n', slug: c.slug, type: 'SUBCATEGORY', parentId: root.id })
      .expect(409);
    const cyc = await authed('patch', `/api/v1/admin/categories/${root.id}`)
      .send({ type: 'SUBCATEGORY', parentId: c.id })
      .expect(400);
    expect(err(cyc.body)).toBe('CATEGORY_CYCLE');
  });

  it('AC4: PATCH omitting dimension keeps it; dimension:null with parentId clears it; ROOT->SUBCATEGORY bare => 400', async () => {
    const root = await mk();
    const c = await mk({
      type: 'SUBCATEGORY',
      dimension: 'FRANCHISE',
      parentId: root.id,
    });
    const kept = await authed('patch', `/api/v1/admin/categories/${c.id}`)
      .send({ name: 'renamed' })
      .expect(200);
    expect((kept.body as Cat).dimension).toBe('FRANCHISE');
    const cleared = await authed('patch', `/api/v1/admin/categories/${c.id}`)
      .send({ dimension: null })
      .expect(200);
    expect((cleared.body as Cat).dimension).toBeNull();
    const bare = await authed('patch', `/api/v1/admin/categories/${root.id}`)
      .send({ type: 'SUBCATEGORY' })
      .expect(400);
    expect(err(bare.body)).toBe('CATEGORY_DIMENSION_INVALID');
  });

  it('AC5: subcategories with null dimension never appear in facets franchises/formats', async () => {
    const root = await mk();
    const c = await mk({ type: 'SUBCATEGORY', parentId: root.id });
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/facets')
      .expect(200);
    const f = res.body as {
      franchises: { id: string }[];
      formats: { id: string }[];
    };
    expect(f.franchises.some((x) => x.id === c.id)).toBe(false);
    expect(f.formats.some((x) => x.id === c.id)).toBe(false);
  });

  it('AC6: admin list parentId returns only direct children, combines with filters, 400 on invalid', async () => {
    const root = await mk();
    const other = await mk();
    const a = await mk({ type: 'SUBCATEGORY', parentId: root.id });
    const b = await mk({
      type: 'SUBCATEGORY',
      parentId: root.id,
      isActive: false,
    });
    const grand = await mk({ type: 'SUBCATEGORY', parentId: a.id });
    await mk({ type: 'SUBCATEGORY', parentId: other.id });
    const ids = (rows: Cat[]) => rows.map((r) => r.id).sort();
    expect(ids(await list(`?parentId=${root.id}`))).toEqual(
      [a.id, b.id].sort(),
    );
    expect(ids(await list(`?parentId=${root.id}&isActive=false`))).toEqual([
      b.id,
    ]);
    expect(ids(await list(`?parentId=${root.id}&type=ROOT`))).toEqual([]);
    expect(ids(await list(`?parentId=${root.id}&search=${a.slug}`))).toEqual([
      a.id,
    ]);
    expect(ids(await list(`?parentId=${a.id}`))).toEqual([grand.id]);
    await authed('get', '/api/v1/admin/categories?parentId=abc').expect(400);
    await authed('get', '/api/v1/admin/categories?parentId=null').expect(400);
  });

  it('AC7: admin list ordered by sortOrder, name, id (with and without search), same as public', async () => {
    const root = await mk();
    const z = await mk(
      { type: 'SUBCATEGORY', parentId: root.id, sortOrder: 1 },
      'zz',
    );
    const m = await mk(
      { type: 'SUBCATEGORY', parentId: root.id, sortOrder: 2 },
      'aa',
    );
    const n = await mk(
      { type: 'SUBCATEGORY', parentId: root.id, sortOrder: 1 },
      'bb',
    );
    const expected = [n.id, z.id, m.id].sort((x, y) => {
      const o = [n, z, m];
      const cx = o.find((c) => c.id === x)!;
      const cy = o.find((c) => c.id === y)!;
      return cx.sortOrder - cy.sortOrder || cx.name.localeCompare(cy.name);
    });
    const rows = await list(`?parentId=${root.id}`);
    expect(rows.map((r) => r.id)).toEqual(expected);
    expect(rows[0]).toHaveProperty('_count.products', 0);
    const searched = await list(`?parentId=${root.id}&search=${PREFIX}`);
    expect(searched.map((r) => r.id)).toEqual(expected);
    const pub = await request(app.getHttpServer())
      .get(`/api/v1/categories?parentId=${root.id}`)
      .expect(200);
    expect((pub.body as Cat[]).map((r) => r.id)).toEqual(expected);
  });

  it('AC8: public GET /categories?type=ROOT and ?parentId= (regression)', async () => {
    const root = await mk();
    const c = await mk({ type: 'SUBCATEGORY', parentId: root.id });
    const roots = await request(app.getHttpServer())
      .get('/api/v1/categories?type=ROOT')
      .expect(200);
    const rootRows = roots.body as Cat[];
    expect(rootRows.some((r) => r.id === root.id)).toBe(true);
    expect(rootRows.every((r) => r.type === 'ROOT')).toBe(true);
    expect(rootRows.some((r) => r.id === c.id)).toBe(false);
    const kids = await request(app.getHttpServer())
      .get(`/api/v1/categories?parentId=${root.id}`)
      .expect(200);
    expect((kids.body as Cat[]).map((r) => r.id)).toEqual([c.id]);
    await prisma.category.update({
      where: { id: root.id },
      data: { isActive: false },
    });
    const hidden = await request(app.getHttpServer())
      .get(`/api/v1/categories?parentId=${root.id}`)
      .expect(200);
    expect(hidden.body).toEqual([]);
  });
});
