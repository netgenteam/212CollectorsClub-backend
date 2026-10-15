import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const TEST_USERNAME = 'e2e-admin-story-13-7-reg';
const TEST_EMAIL = 'e2e-admin-story-13-7-reg@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-13a7r';

// Pre-Epic-13 response shapes (state at the commit before Story 13.1). Epic 13
// is additive-only (AD-40, A18): every field below must still be present.
const PRE_CATEGORY = ['id', 'name', 'slug'];
const PRE_LIST_ITEM = [
  'id',
  'name',
  'slug',
  'isPreorder',
  'releaseDate',
  'price',
  'inStock',
  'availableStock',
  'franchise',
  'productType',
  'rarity',
  'primaryImage',
];
const PRE_DETAIL = [
  'id',
  'name',
  'slug',
  'description',
  'price',
  'inStock',
  'availableStock',
  'franchise',
  'productType',
  'rarity',
  'isPreorder',
  'releaseDate',
  'grading',
  'category',
  'images',
  'marketReferences',
];
const PRE_ADMIN_PRODUCT = [
  'id',
  'name',
  'slug',
  'description',
  'franchise',
  'productType',
  'rarity',
  'priceUsd',
  'stock',
  'heldQty',
  'isActive',
  'isPreorder',
  'releaseDate',
  'gradingCompany',
  'gradeValue',
  'certNumber',
  'category',
  'images',
  'marketReferences',
  'createdAt',
  'updatedAt',
];
const PRE_ADMIN_CATEGORY = ['id', 'name', 'slug'];

type Obj = Record<string, unknown>;
const expectSuperset = (body: Obj, pre: string[]) => {
  for (const k of pre) expect(body, `missing field ${k}`).toHaveProperty(k);
};

// Story 13.7 (AC13, AD-40, A18): Epic 13 contract smoke.
describe('Epic 13 regression (e2e, Story 13.7)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
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
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    accessToken = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const authGet = (path: string) =>
    get(path).set('Authorization', `Bearer ${accessToken}`);

  it('public category, list and detail responses only add fields', async () => {
    const cats = (await get('/api/v1/categories').expect(200)).body as Obj[];
    expect(cats.length).toBeGreaterThan(0);
    expectSuperset(cats[0], PRE_CATEGORY);

    const list = (await get('/api/v1/products?limit=5').expect(200)).body as {
      data: Obj[];
    };
    expect(list.data.length).toBeGreaterThan(0);
    expectSuperset(list.data[0], PRE_LIST_ITEM);

    const detail = (
      await get(`/api/v1/products/${list.data[0].id as string}`).expect(200)
    ).body as Obj;
    expectSuperset(detail, PRE_DETAIL);
  });

  it('admin product and admin category responses only add fields', async () => {
    const pb = (await authGet('/api/v1/admin/products').expect(200)).body as
      Obj[] | { data: Obj[] };
    const products = Array.isArray(pb) ? pb : pb.data;
    expectSuperset(products[0], PRE_ADMIN_PRODUCT);
    const cats = (await authGet('/api/v1/admin/categories').expect(200))
      .body as Obj[];
    expectSuperset(cats[0], PRE_ADMIN_CATEGORY);
  });

  it('franchise=POKEMON single value still works; macroCategory resolves by productType', async () => {
    const one = (
      await get('/api/v1/products?franchise=POKEMON&limit=50').expect(200)
    ).body as { data: Obj[] };
    expect(one.data.length).toBeGreaterThan(0);
    for (const p of one.data) expect(p.franchise).toBe('POKEMON');

    const singles = (
      await get('/api/v1/products?macroCategory=SINGLES&limit=50').expect(200)
    ).body as { data: Obj[] };
    expect(singles.data.length).toBeGreaterThan(0);
    for (const p of singles.data) expect(p.productType).toBe('SINGLE_CARD');
    const sealed = (
      await get('/api/v1/products?macroCategory=SEALED&limit=50').expect(200)
    ).body as { data: Obj[] };
    for (const p of sealed.data) expect(p.productType).not.toBe('SINGLE_CARD');
  });
});
