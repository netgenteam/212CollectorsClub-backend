import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

interface MarketRef {
  provider: string;
  label: string;
  url: string;
  suggestedPriceEur?: number;
}

interface Detail {
  marketReferences: MarketRef[];
}

interface AdminProduct {
  id: string;
  gradingCompany: string | null;
  certNumber: string | null;
  marketReferences: Array<MarketRef & { suggestedPriceEur: number | null }>;
}

const TEST_USERNAME = 'e2e-admin-story-11-4';
const TEST_EMAIL = 'e2e-admin-story-11-4@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-11a4';
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';
const IMAGE_FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'product-image-fixture.png',
);

describe('Market references and PSA link (e2e, Story 11.4)', () => {
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

  const CM = {
    provider: 'CARDMARKET',
    label: 'Cardmarket',
    url: 'https://www.cardmarket.com/en/Pokemon/x',
    suggestedPriceEur: 12.5,
  };
  const PC = {
    provider: 'PRICECHARTING',
    label: 'PriceCharting',
    url: 'https://www.pricecharting.com/y',
  };

  function detail(id: string) {
    return request(app.getHttpServer()).get(`/api/v1/products/${id}`);
  }

  function patch(id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  it('schema: table, enum and cascade exist', async () => {
    const enums = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'MarketProvider' ORDER BY e.enumsortorder`;
    expect(enums.map((e) => e.enumlabel)).toEqual([
      'CARDMARKET',
      'PRICECHARTING',
      'PSA_CERT',
      'TCGPLAYER',
    ]);
    const fk = await prisma.$queryRaw<{ confdeltype: string }[]>`
      SELECT confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname = 'Product_Market_References_productId_fkey'`;
    expect(fk[0].confdeltype).toBe('c');
  });

  it('seed stores >=2 products with references, one with suggestedPriceEur', async () => {
    const rows = await prisma.productMarketReference.findMany();
    expect(new Set(rows.map((r) => r.productId)).size).toBeGreaterThanOrEqual(
      2,
    );
    expect(rows.some((r) => r.suggestedPriceEur !== null)).toBe(true);
    const keys = rows.map((r) => `${r.productId}|${r.provider}|${r.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('detail lists stored references ordered by sortOrder; list never includes them', async () => {
    const withRefs = await prisma.productMarketReference.findFirstOrThrow({
      where: { suggestedPriceEur: { not: null } },
    });
    const res = await detail(withRefs.productId).expect(200);
    const refs = (res.body as Detail).marketReferences;
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs[0].suggestedPriceEur).toBe(Number(withRefs.suggestedPriceEur));
    expect(refs[1].suggestedPriceEur).toBeUndefined();

    const list = await request(app.getHttpServer())
      .get('/api/v1/products?limit=100')
      .expect(200);
    for (const item of (list.body as { data: object[] }).data) {
      expect(item).not.toHaveProperty('marketReferences');
    }
  });

  it('product without references returns [] (never null)', async () => {
    const bare = await prisma.product.findFirstOrThrow({
      where: {
        isActive: true,
        marketReferences: { none: {} },
        gradingCompany: null,
      },
    });
    const res = await detail(bare.id).expect(200);
    expect((res.body as Detail).marketReferences).toEqual([]);
  });

  it('PSA slab gets a calculated (not stored) PSA_CERT link, no duplicates', async () => {
    const slab = await prisma.product.findFirstOrThrow({
      where: { gradingCompany: 'PSA', certNumber: { not: null } },
    });
    const before = await prisma.productMarketReference.count({
      where: { productId: slab.id, provider: 'PSA_CERT' },
    });
    const refs = ((await detail(slab.id).expect(200)).body as Detail)
      .marketReferences;
    const psa = refs.filter((r) => r.provider === 'PSA_CERT');
    expect(psa).toEqual([
      {
        provider: 'PSA_CERT',
        label: 'PSA Cert Verification',
        url: `https://www.psacard.com/cert/${slab.certNumber}`,
      },
    ]);
    expect(refs[refs.length - 1].provider).toBe('PSA_CERT');
    expect(
      await prisma.productMarketReference.count({
        where: { productId: slab.id, provider: 'PSA_CERT' },
      }),
    ).toBe(before);
  });

  it('BGS slab and invalid/empty cert produce no PSA link', async () => {
    const bgs = await prisma.product.findFirstOrThrow({
      where: { gradingCompany: 'BGS' },
    });
    const res = await detail(bgs.id).expect(200);
    expect(
      (res.body as Detail).marketReferences.some(
        (r) => r.provider === 'PSA_CERT',
      ),
    ).toBe(false);
  });

  describe('admin create/patch', () => {
    it('create accepts marketReferences as JSON string (multipart), returns them stored', async () => {
      const res = await createRequest({
        marketReferences: JSON.stringify([CM, PC]),
      }).expect(201);
      const created = res.body as AdminProduct;
      createdIds.push(created.id);
      expect(created.marketReferences.map((r) => r.provider)).toEqual([
        'CARDMARKET',
        'PRICECHARTING',
      ]);
      expect(created.marketReferences[0].suggestedPriceEur).toBe(12.5);
      expect(created.marketReferences[1].suggestedPriceEur).toBeNull();
    });

    it('create rejects http(s)-less / javascript: url and unknown provider with 400, persisting nothing', async () => {
      const before = await prisma.product.count();
      await createRequest({
        marketReferences: JSON.stringify([
          { ...CM, url: 'javascript:alert(1)' },
        ]),
      }).expect(400);
      await createRequest({
        marketReferences: JSON.stringify([{ ...CM, provider: 'EBAY' }]),
      }).expect(400);
      expect(await prisma.product.count()).toBe(before);
    });

    it('PATCH: omitted leaves refs untouched; array replaces; [] clears; invalid is 400 and keeps old', async () => {
      const created = (
        await createRequest({ marketReferences: JSON.stringify([CM]) }).expect(
          201,
        )
      ).body as AdminProduct;
      createdIds.push(created.id);

      let res = await patch(created.id, { name: 'Renamed' }).expect(200);
      expect((res.body as AdminProduct).marketReferences).toHaveLength(1);

      res = await patch(created.id, { marketReferences: [PC, CM] }).expect(200);
      expect(
        (res.body as AdminProduct).marketReferences.map((r) => r.provider),
      ).toEqual(['PRICECHARTING', 'CARDMARKET']);
      expect(
        await prisma.productMarketReference.count({
          where: { productId: created.id },
        }),
      ).toBe(2);

      await patch(created.id, {
        marketReferences: [{ ...PC, url: 'javascript:alert(1)' }],
      }).expect(400);
      await patch(created.id, {
        marketReferences: [{ ...PC, suggestedPriceEur: -1 }],
      }).expect(400);
      await patch(created.id, { marketReferences: [PC, PC] }).expect(400);
      expect(
        await prisma.productMarketReference.count({
          where: { productId: created.id },
        }),
      ).toBe(2);

      res = await patch(created.id, { marketReferences: [] }).expect(200);
      expect((res.body as AdminProduct).marketReferences).toEqual([]);
      expect(
        (
          await detail(created.id)
            .expect(200)
            .then((r) => r.body as Detail)
        ).marketReferences,
      ).toEqual([]);
    });

    it('PATCH is atomic: a failing product update leaves previous references intact', async () => {
      const created = (
        await createRequest({ marketReferences: JSON.stringify([CM]) }).expect(
          201,
        )
      ).body as AdminProduct;
      createdIds.push(created.id);
      await patch(created.id, {
        categoryId: randomUUID(),
        marketReferences: [PC],
      }).expect(400);
      const rows = await prisma.productMarketReference.findMany({
        where: { productId: created.id },
      });
      expect(rows.map((r) => r.provider)).toEqual(['CARDMARKET']);
    });

    it('calculated PSA link follows the current grading state after PATCH', async () => {
      const created = (
        await createRequest({
          gradingCompany: 'PSA',
          gradeValue: '10',
          certNumber: 'PSA777',
        }).expect(201)
      ).body as AdminProduct;
      createdIds.push(created.id);
      let refs = ((await detail(created.id).expect(200)).body as Detail)
        .marketReferences;
      expect(refs).toEqual([
        {
          provider: 'PSA_CERT',
          label: 'PSA Cert Verification',
          url: 'https://www.psacard.com/cert/PSA777',
        },
      ]);

      await patch(created.id, { certNumber: 'PSA888' }).expect(200);
      refs = ((await detail(created.id).expect(200)).body as Detail)
        .marketReferences;
      expect(refs[0].url).toBe('https://www.psacard.com/cert/PSA888');

      await patch(created.id, { gradingCompany: 'BGS' }).expect(200);
      refs = ((await detail(created.id).expect(200)).body as Detail)
        .marketReferences;
      expect(refs).toEqual([]);

      await patch(created.id, { gradingCompany: null }).expect(200);
      refs = ((await detail(created.id).expect(200)).body as Detail)
        .marketReferences;
      expect(refs).toEqual([]);
    });

    it('deleting the product cascades its references', async () => {
      const created = (
        await createRequest({ marketReferences: JSON.stringify([CM]) }).expect(
          201,
        )
      ).body as AdminProduct;
      await prisma.product.delete({ where: { id: created.id } });
      expect(
        await prisma.productMarketReference.count({
          where: { productId: created.id },
        }),
      ).toBe(0);
    });
  });
});
