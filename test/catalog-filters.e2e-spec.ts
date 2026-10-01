import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import type { ProductType } from './../src/generated/prisma/enums.js';

interface ListItem {
  id: string;
  name: string;
  productType: string;
  isPreorder: boolean;
  inStock: boolean;
}
interface ListBody {
  data: ListItem[];
  meta: { total: number; totalPages: number };
}

const SEALED = [
  'BOOSTER_PACK',
  'BOOSTER_BOX',
  'STARTER_DECK',
  'COLLECTOR_TIN',
  'ACCESSORY',
];
const SEEDED_CATEGORY_ID = '7bfd9c58-b7c4-490c-8232-6a463b87c262';

// Story 11.2 (FR-32): macroCategory, productType[], onlyInStock, onlyPreorder.
describe('Catalog filters (e2e, Story 11.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdIds: string[] = [];
  const token = `Zqxv${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
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

    const mk = async (
      suffix: string,
      productType: ProductType,
      stock: number,
      heldQty: number,
      isPreorder: boolean,
    ) => {
      const p = await prisma.product.create({
        data: {
          name: `${token} ${suffix}`,
          slug: `${token.toLowerCase()}-${suffix}`,
          description: 'Created by e2e 11.2.',
          franchise: 'POKEMON',
          productType,
          rarity: 'COMMON',
          priceUsd: '9.99',
          stock,
          heldQty,
          isPreorder,
          categoryId: SEEDED_CATEGORY_ID,
        },
      });
      createdIds.push(p.id);
    };
    await mk('boxinstock', 'BOOSTER_BOX', 5, 0, false);
    await mk('boxheld', 'BOOSTER_BOX', 3, 3, false);
    await mk('tinpre', 'COLLECTOR_TIN', 0, 0, true);
    await mk('singlepre', 'SINGLE_CARD', 4, 1, true);
    await mk('singleplain', 'SINGLE_CARD', 2, 0, false);
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    await app.close();
  });

  const get = (qs: string) =>
    request(app.getHttpServer()).get(`/api/v1/products?${qs}`);

  it('macroCategory=SEALED returns only sealed types, SINGLES only SINGLE_CARD', async () => {
    const sealed = await get('macroCategory=SEALED&limit=100').expect(200);
    const sBody = sealed.body as ListBody;
    expect(sBody.data.length).toBeGreaterThan(0);
    expect(sBody.data.every((p) => SEALED.includes(p.productType))).toBe(true);
    expect(sBody.meta.total).toBe(
      await prisma.product.count({
        where: { isActive: true, productType: { in: SEALED as ProductType[] } },
      }),
    );

    const singles = await get('macroCategory=SINGLES&limit=100').expect(200);
    const gBody = singles.body as ListBody;
    expect(gBody.data.every((p) => p.productType === 'SINGLE_CARD')).toBe(true);
    expect(gBody.meta.total).toBe(
      await prisma.product.count({
        where: { isActive: true, productType: 'SINGLE_CARD' },
      }),
    );
  });

  it('accepts a single and a repeated productType', async () => {
    const one = (await get('productType=BOOSTER_BOX&limit=100').expect(200))
      .body as ListBody;
    expect(one.data.every((p) => p.productType === 'BOOSTER_BOX')).toBe(true);

    const two = (
      await get(
        'productType=BOOSTER_BOX&productType=COLLECTOR_TIN&limit=100',
      ).expect(200)
    ).body as ListBody;
    const types = new Set(two.data.map((p) => p.productType));
    expect(types).toEqual(new Set(['BOOSTER_BOX', 'COLLECTOR_TIN']));
    expect(two.meta.total).toBeGreaterThan(one.meta.total);
  });

  it('intersects macroCategory with productType[]', async () => {
    const ok = (
      await get(
        'macroCategory=SEALED&productType=BOOSTER_BOX&productType=SINGLE_CARD&limit=100',
      ).expect(200)
    ).body as ListBody;
    expect(ok.data.every((p) => p.productType === 'BOOSTER_BOX')).toBe(true);

    const empty = (
      await get('macroCategory=SEALED&productType=SINGLE_CARD').expect(200)
    ).body as ListBody;
    expect(empty.data).toEqual([]);
    expect(empty.meta.total).toBe(0);
  });

  it('onlyPreorder / onlyInStock combine by AND with search and keep total consistent', async () => {
    const pre = (
      await get(`search=${token}&onlyPreorder=true&limit=100`).expect(200)
    ).body as ListBody;
    expect(pre.data.map((p) => p.name).sort()).toEqual([
      `${token} singlepre`,
      `${token} tinpre`,
    ]);
    expect(pre.meta.total).toBe(2);

    const stock = (
      await get(`search=${token}&onlyInStock=true&limit=100`).expect(200)
    ).body as ListBody;
    expect(stock.data.map((p) => p.name).sort()).toEqual([
      `${token} boxinstock`,
      `${token} singleplain`,
      `${token} singlepre`,
    ]);
    expect(stock.data.every((p) => p.inStock)).toBe(true);

    const both = (
      await get(
        `search=${token}&onlyInStock=true&onlyPreorder=true&macroCategory=SINGLES&limit=1`,
      ).expect(200)
    ).body as ListBody;
    expect(both.meta.total).toBe(1);
    expect(both.data[0].name).toBe(`${token} singlepre`);
  });

  it('onlyPreorder=false / onlyInStock=false do not filter', async () => {
    const all = (await get(`search=${token}&limit=100`).expect(200))
      .body as ListBody;
    const f = (
      await get(
        `search=${token}&onlyPreorder=false&onlyInStock=false&limit=100`,
      ).expect(200)
    ).body as ListBody;
    expect(f.meta.total).toBe(all.meta.total);
    expect(f.data.some((p) => !p.isPreorder)).toBe(true);
  });

  it('returns 400 for invalid enum, non-boolean flags and >10 productType', async () => {
    await get('macroCategory=NOPE').expect(400);
    await get('productType=NOPE').expect(400);
    await get('productType=BOOSTER_BOX&productType=NOPE').expect(400);
    await get('onlyPreorder=maybe').expect(400);
    await get('onlyInStock=1').expect(400);
    const eleven = Array(11)
      .fill('BOOSTER_BOX')
      .map((v) => `productType=${v}`);
    await get(eleven.join('&')).expect(400);
  });

  it('is injection-safe on the new params', async () => {
    await get('productType=BOOSTER_BOX\'; DROP TABLE "Products";--').expect(
      400,
    );
    await get("macroCategory=SEALED' OR '1'='1").expect(400);
    await get("onlyPreorder=true' OR '1'='1").expect(400);
    const ok = await get('limit=1').expect(200);
    expect((ok.body as ListBody).meta.total).toBeGreaterThan(0);
  });
});
