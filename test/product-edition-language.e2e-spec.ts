import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface Item {
  id: string;
  slug: string;
  editionLanguage?: string;
}

const TEST_USERNAME = 'e2e-admin-story-13-4';
const TEST_EMAIL = 'e2e-admin-story-13-4@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-13a4';
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

// Story 13.4 (FR-49, AD-33/36/38): product edition language.
describe('Product edition language (e2e, Story 13.4)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;
  const createdIds: string[] = [];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
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
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  function createRequest(extra: Record<string, string> = {}) {
    const slug = `e2e-lang-${randomUUID().slice(0, 8)}`;
    let req = request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('name', 'E2E Language Product')
      .field('slug', slug)
      .field('description', 'Created by e2e.')
      .field('franchise', 'POKEMON')
      .field('productType', 'SINGLE_CARD')
      .field('rarity', 'COMMON')
      .field('priceUsd', '9.99')
      .field('stock', '5')
      .field('categoryId', SEEDED_CATEGORY_ID);
    for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
    return req.attach('images', IMAGE_FIXTURE_PATH);
  }

  function patch(id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function create(extra: Record<string, string> = {}): Promise<Item> {
    const res = await createRequest(extra).expect(201);
    const item = res.body as Item;
    createdIds.push(item.id);
    return item;
  }

  it('AC1: column is NOT NULL default EN, indexed; existing rows are EN', async () => {
    const cols = await prisma.$queryRaw<
      { is_nullable: string; column_default: string }[]
    >`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'Products' AND column_name = 'editionLanguage'`;
    expect(cols[0].is_nullable).toBe('NO');
    expect(cols[0].column_default).toContain("'EN'");
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Products' AND indexname = 'Products_editionLanguage_idx'`;
    expect(idx).toHaveLength(1);
    const notEn = await prisma.product.count({
      where: {
        slug: { not: { startsWith: 'e2e-' } },
        editionLanguage: { not: 'EN' },
      },
    });
    expect(notEn).toBe(0);
  });

  it('AC2: POST without the field defaults to EN; valid codes are stored', async () => {
    const def = await create();
    expect(def.editionLanguage).toBe('EN');
    for (const code of ['ES', 'EN', 'JP', 'CN', 'OTHER']) {
      const p = await create({ editionLanguage: code });
      expect(p.editionLanguage).toBe(code);
      const row = await prisma.product.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.editionLanguage).toBe(code);
    }
  });

  it.each(['jp', 'FR', '', '5'])(
    'AC3: POST rejects editionLanguage %p with 400 and persists nothing',
    async (value) => {
      const before = await prisma.product.count();
      await createRequest({ editionLanguage: value }).expect(400);
      expect(await prisma.product.count()).toBe(before);
    },
  );

  it.each([null, 'jp', 'FR', 5, ''])(
    'AC3: PATCH rejects editionLanguage %p with 400 and leaves the row untouched',
    async (value) => {
      const p = await create({ editionLanguage: 'ES' });
      await patch(p.id, { editionLanguage: value }).expect(400);
      const row = await prisma.product.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.editionLanguage).toBe('ES');
    },
  );

  it('AC3: PATCH without the field keeps the value; PATCH JP updates only that field', async () => {
    const p = await create({ editionLanguage: 'ES' });
    await patch(p.id, { name: 'Renamed' }).expect(200);
    const row = await prisma.product.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect(row.editionLanguage).toBe('ES');
    const res = await patch(p.id, { editionLanguage: 'JP' }).expect(200);
    expect((res.body as Item).editionLanguage).toBe('JP');
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect(after.editionLanguage).toBe('JP');
    expect(after.name).toBe('Renamed');
    expect(after.stock).toBe(row.stock);
  });

  it('AC4/5: public list, detail, related and admin list/detail expose editionLanguage', async () => {
    const p = await create({ editionLanguage: 'JP' });
    const sibling = await create({ editionLanguage: 'CN' });

    const list = await request(app.getHttpServer())
      .get('/api/v1/products?franchise=POKEMON&limit=100&search=E2E Language')
      .expect(200);
    const items = (list.body as { data: Item[] }).data;
    expect(items.find((i) => i.id === p.id)?.editionLanguage).toBe('JP');
    expect(items.find((i) => i.id === sibling.id)?.editionLanguage).toBe('CN');
    for (const i of items) expect(typeof i.editionLanguage).toBe('string');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/products/${p.id}`)
      .expect(200);
    expect((detail.body as Item).editionLanguage).toBe('JP');

    const related = await request(app.getHttpServer())
      .get(`/api/v1/products/${p.id}/related?limit=10`)
      .expect(200);
    const rel = (related.body as { data: Item[] }).data;
    expect(rel.find((i) => i.id === sibling.id)?.editionLanguage).toBe('CN');
    for (const i of rel) expect(typeof i.editionLanguage).toBe('string');

    const adminDetail = await request(app.getHttpServer())
      .get(`/api/v1/admin/products/${p.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((adminDetail.body as Item).editionLanguage).toBe('JP');
    const adminList = await request(app.getHttpServer())
      .get('/api/v1/admin/products?limit=100')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const rows = adminList.body as { data?: Item[] } | Item[];
    const arr = Array.isArray(rows) ? rows : (rows.data ?? []);
    expect(arr.length).toBeGreaterThan(0);
    for (const i of arr) expect(typeof i.editionLanguage).toBe('string');
  });

  it('AC6: Swagger names the ProductLanguage enum and uses it in DTOs', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const schemas = (
      res.body as {
        components: {
          schemas: Record<
            string,
            { enum?: string[]; properties?: Record<string, { $ref?: string }> }
          >;
        };
      }
    ).components.schemas;
    expect(schemas.ProductLanguage.enum).toEqual([
      'ES',
      'EN',
      'JP',
      'CN',
      'OTHER',
    ]);
    for (const name of [
      'ProductListItemDto',
      'ProductDetailDto',
      'AdminProductResponseDto',
      'UpdateProductDto',
    ]) {
      const prop = schemas[name]?.properties?.editionLanguage;
      expect(JSON.stringify(prop)).toContain('ProductLanguage');
    }
  });
});
