import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface ListBody {
  data: { id: string; name: string }[];
  meta: Record<string, unknown>;
}

// Story 15.2 (FR-64, AD-52): additive meta flags + `categoryId[]` alias.
describe('Catalog pagination meta and categoryId[] alias (e2e, Story 15.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const token = randomUUID().slice(0, 8);
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  let A: string;
  let B: string;

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

    const cat = async (n: string) => {
      const c = await prisma.category.create({
        data: {
          name: `${token}-${n}`,
          slug: `${token}-${n}`.toLowerCase(),
          type: 'ROOT',
          isActive: true,
        },
      });
      categoryIds.push(c.id);
      return c.id;
    };
    A = await cat('a');
    B = await cat('b');
    const mk = async (i: number, categoryId: string) => {
      const p = await prisma.product.create({
        data: {
          name: `${token}-p${String(i).padStart(2, '0')}`,
          slug: `${token}-p${i}`,
          description: 'pagination fixture',
          priceUsd: '1.00',
          stock: 5,
          categoryId,
          franchise: 'POKEMON',
          productType: 'SINGLE_CARD',
          rarity: 'COMMON',
        },
      });
      productIds.push(p.id);
    };
    // 25 products tagged with the token: 13 in A, 12 in B.
    for (let i = 0; i < 25; i++) await mk(i, i < 13 ? A : B);
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
    await app.close();
  });

  const list = async (qs: string, status = 200): Promise<ListBody> => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/products?${qs}`)
      .expect(status);
    return res.body as ListBody;
  };
  const q = () => `categoryId=${A}&categoryId=${B}`;

  it('AC1: flags across pages 1..3 of 25 items', async () => {
    const expected = [
      [true, false],
      [true, true],
      [false, true],
    ];
    for (let page = 1; page <= 3; page++) {
      const { meta } = await list(`${q()}&limit=10&page=${page}`);
      expect(meta).toEqual({
        page,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: expected[page - 1][0],
        hasPreviousPage: expected[page - 1][1],
      });
    }
  });

  it('AC2: zero results', async () => {
    const body = await list(`categoryId=${randomUUID()}&limit=10`);
    expect(body.data).toEqual([]);
    expect(body.meta).toMatchObject({
      total: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('AC3: page beyond totalPages', async () => {
    const body = await list(`${q()}&limit=10&page=9`);
    expect(body.data).toEqual([]);
    expect(body.meta).toMatchObject({
      page: 9,
      totalPages: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it('AC4: categoryId[] equals categoryId, mixing merges and dedupes', async () => {
    const plain = await list(`categoryId=${A}&categoryId=${B}&limit=100`);
    const bracket = await list(`categoryId[]=${A}&categoryId[]=${B}&limit=100`);
    expect(plain.meta.total).toBe(25);
    expect(bracket).toEqual(plain);
    const mixed = await list(
      `categoryId=${A}&categoryId[]=${B}&categoryId[]=${A}&limit=100`,
    );
    expect(mixed).toEqual(plain);
    const single = await list(`categoryId[]=${A}&limit=100`);
    expect(single.meta.total).toBe(13);
  });

  it('AC4: uuid validation and 20-id cap still apply to the bracket form', async () => {
    await list('categoryId[]=not-a-uuid', 400);
    const many = Array.from(
      { length: 21 },
      () => `categoryId[]=${randomUUID()}`,
    ).join('&');
    await list(many, 400);
    // 11 plain + 10 bracket = 21 after merge, over the cap
    const mixedMany = [
      ...Array.from({ length: 11 }, () => `categoryId=${randomUUID()}`),
      ...Array.from({ length: 10 }, () => `categoryId[]=${randomUUID()}`),
    ].join('&');
    await list(mixedMany, 400);
  });

  it('AC6: Swagger documents both flags and the alias', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    );
    const meta = doc.components?.schemas?.PaginationMetaDto as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(meta.properties)).toEqual(
      expect.arrayContaining(['hasNextPage', 'hasPreviousPage']),
    );
    const query = doc.components?.schemas?.ListProductsQueryDto as {
      properties: { categoryId: { description: string } };
    };
    expect(query?.properties?.categoryId?.description ?? '').not.toMatch(
      /not supported/,
    );
  });
});
