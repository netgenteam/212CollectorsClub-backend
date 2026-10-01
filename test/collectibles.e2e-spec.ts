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

interface ListItem {
  id: string;
  slug: string;
  franchise: string;
  productType: string;
  isPreorder: boolean;
  releaseDate: string | null;
  primaryImage: { id: string; sortOrder: number; url: string } | null;
}

interface Detail extends ListItem {
  grading: {
    company: string;
    grade: string | null;
    certNumber: string | null;
  } | null;
}

interface AdminProduct {
  id: string;
  isPreorder: boolean;
  releaseDate: string | null;
  gradingCompany: string | null;
  gradeValue: string | null;
  certNumber: string | null;
}

const TEST_USERNAME = 'e2e-admin-story-11-1';
const TEST_EMAIL = 'e2e-admin-story-11-1@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-11a1';
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

// Story 11.1 (FR-35): collectibles schema, seed and serialization.
describe('Collectibles fields (e2e, Story 11.1)', () => {
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
    let req = request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('name', 'E2E Collectible')
      .field('slug', `e2e-collectible-${randomUUID().slice(0, 8)}`)
      .field('description', 'Created by e2e.')
      .field('franchise', 'TOPPS')
      .field('productType', 'ACCESSORY')
      .field('rarity', 'COMMON')
      .field('priceUsd', '9.99')
      .field('stock', '5')
      .field('categoryId', SEEDED_CATEGORY_ID);
    for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
    return req.attach('images', IMAGE_FIXTURE_PATH);
  }

  it('seed data (idempotent) exposes TOPPS, NARUTO, ACCESSORY, a preorder and PSA/BGS slabs', async () => {
    const rows = await prisma.product.findMany();
    expect(rows.some((p) => p.franchise === 'TOPPS')).toBe(true);
    expect(rows.some((p) => p.franchise === 'NARUTO')).toBe(true);
    expect(rows.some((p) => p.productType === 'ACCESSORY')).toBe(true);
    expect(rows.some((p) => p.isPreorder && p.releaseDate)).toBe(true);
    expect(rows.some((p) => p.gradingCompany === 'PSA' && p.certNumber)).toBe(
      true,
    );
    expect(
      rows.some((p) => ['BGS', 'CGC'].includes(p.gradingCompany ?? '')),
    ).toBe(true);
    const slugs = rows.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('list items add slug/isPreorder/releaseDate/primaryImage.id+sortOrder; default limit stays 20', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/products?franchise=POKEMON&limit=100')
      .expect(200);
    const body = res.body as { data: ListItem[] };
    const preorder = body.data.find((p) => p.isPreorder);
    expect(preorder?.releaseDate).toBe('2027-01-15T00:00:00.000Z');
    const first = body.data[0];
    expect(typeof first.slug).toBe('string');
    expect(first.isPreorder).toBeDefined();
    expect(first.primaryImage?.id).toBeDefined();
    expect(first.primaryImage?.sortOrder).toBe(0);

    const def = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);
    expect((def.body as { meta: { limit: number } }).meta.limit).toBe(20);
  });

  it('detail adds grading {company, grade, certNumber} for a slab and null for a raw product', async () => {
    const slab = await prisma.product.findFirstOrThrow({
      where: { gradingCompany: 'PSA' },
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/products/${slab.id}`)
      .expect(200);
    const detail = res.body as Detail;
    expect(detail.grading).toEqual({
      company: 'PSA',
      grade: slab.gradeValue,
      certNumber: slab.certNumber,
    });
    expect(detail.isPreorder).toBe(false);

    const rawProduct = await prisma.product.findFirstOrThrow({
      where: { gradingCompany: null, isActive: true },
    });
    const rawRes = await request(app.getHttpServer())
      .get(`/api/v1/products/${rawProduct.id}`)
      .expect(200);
    expect((rawRes.body as Detail).grading).toBeNull();
  });

  describe('admin POST/PATCH validation', () => {
    it('persists and returns valid preorder + grading fields', async () => {
      const res = await createRequest({
        isPreorder: 'true',
        releaseDate: '2027-03-01T00:00:00.000Z',
        gradingCompany: 'CGC',
        gradeValue: '9.5',
        certNumber: 'ABC123',
      }).expect(201);
      const created = res.body as AdminProduct;
      createdIds.push(created.id);
      expect(created).toMatchObject({
        isPreorder: true,
        releaseDate: '2027-03-01T00:00:00.000Z',
        gradingCompany: 'CGC',
        gradeValue: '9.5',
        certNumber: 'ABC123',
      });

      const patched = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${created.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isPreorder: false, gradingCompany: 'BGS', certNumber: 'ZZ9' })
        .expect(200);
      expect(patched.body).toMatchObject({
        isPreorder: false,
        gradingCompany: 'BGS',
        certNumber: 'ZZ9',
      });
    });

    it.each([
      ['certNumber without gradingCompany', { certNumber: 'ABC123' }],
      ['gradeValue without gradingCompany', { gradeValue: '9' }],
      ['certNumber with RAW', { gradingCompany: 'RAW', certNumber: 'ABC' }],
      [
        'non-alphanumeric certNumber',
        { gradingCompany: 'PSA', certNumber: 'AB-12' },
      ],
      ['unknown gradingCompany', { gradingCompany: 'XYZ' }],
    ])('POST rejects %s with 400', async (_l, fields) => {
      await createRequest(fields).expect(400);
    });

    it('PATCH rejects certNumber without gradingCompany with 400', async () => {
      const seeded = await prisma.product.findFirstOrThrow();
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${seeded.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ certNumber: 'ABC123' })
        .expect(400);
    });
  });

  it('Swagger exposes Franchise, ProductType, Rarity and GradingCompany as named component schemas', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    );
    const schemas = Object.keys(doc.components?.schemas ?? {});
    for (const name of [
      'Franchise',
      'ProductType',
      'Rarity',
      'GradingCompany',
    ]) {
      expect(schemas).toContain(name);
    }
  });
});
