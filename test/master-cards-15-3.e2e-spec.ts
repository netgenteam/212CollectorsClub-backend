import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  TcgApiClient,
} from './../src/tcg/tcg-api-client.interface.js';
import { FakeTcgApiClient } from './../src/tcg/fake-tcg-api-client.js';

type App = Parameters<typeof request>[0];

const PREFIX = 'e2e153-';

/**
 * Story 15.3 (FR-65, FR-66; AD-53, AD-54): MasterCard schema, Product link
 * and the TCG client wiring. All rows use the `e2e153-` prefix.
 */
describe('Master cards schema + TCG client (e2e, Story 15.3)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

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
  });

  afterEach(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: PREFIX } },
    });
    await app.close();
  });

  const mkCard = (n: string) =>
    prisma.masterCard.create({
      data: {
        externalProvider: 'FAKE',
        externalId: `${PREFIX}${n}`,
        name: `E2E Card ${n}`,
        cleanName: `e2e card ${n}`,
        searchText: `e2e card ${n} e2e set 001`,
        franchise: 'POKEMON',
        gameSlug: 'pokemon',
        setId: `${PREFIX}set`,
        setName: 'E2E Set',
        marketPriceUsd: '1.50',
        rawApiData: { id: n },
      },
    });

  async function mkProduct(masterCardId: string | null) {
    const category = await prisma.category.findFirstOrThrow();
    return prisma.product.create({
      data: {
        name: `E2E ${randomUUID().slice(0, 6)}`,
        slug: `${PREFIX}${randomUUID().slice(0, 8)}`,
        description: 'e2e',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        priceUsd: '2.00',
        stock: 1,
        categoryId: category.id,
        masterCardId,
      },
    });
  }

  it('AC1: Master_Cards constraints, indexes and Products columns exist', async () => {
    const idx = await prisma.$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Master_Cards'`;
    const defs = idx.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/UNIQUE INDEX.*\("externalProvider", "externalId"\)/);
    expect(defs).toMatch(/USING gin \("searchText" gin_trgm_ops\)/);
    expect(defs).toMatch(/\(franchise, "setId"\)/);
    expect(defs).toMatch(/\("setId"\)/);

    const cols = await prisma.$queryRaw<
      Array<{ column_name: string; column_default: string | null }>
    >`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'Products' AND column_name IN ('masterCardId','isManual','autoSyncPrice','lastMarketSyncAt')`;
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'autoSyncPrice',
      'isManual',
      'lastMarketSyncAt',
      'masterCardId',
    ]);
    const fk = await prisma.$queryRaw<Array<{ delete_rule: string }>>`
      SELECT rc.delete_rule FROM information_schema.referential_constraints rc
      WHERE rc.constraint_name = 'Products_masterCardId_fkey'`;
    expect(fk[0].delete_rule).toBe('SET NULL');

    const bad = await prisma.product.count({
      where: {
        OR: [{ isManual: false }, { autoSyncPrice: true }],
        slug: { not: { startsWith: PREFIX } },
      },
    });
    expect(bad).toBe(0);
    const p = await mkProduct(null);
    expect(p).toMatchObject({
      isManual: true,
      autoSyncPrice: false,
      masterCardId: null,
      lastMarketSyncAt: null,
    });
  });

  it('AC1: unique (externalProvider, externalId)', async () => {
    await mkCard('dup');
    await expect(mkCard('dup')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('AC2: deleting a MasterCard keeps the Product with masterCardId null', async () => {
    const card = await mkCard('del');
    const product = await mkProduct(card.id);
    expect(product.masterCardId).toBe(card.id);
    await prisma.masterCard.delete({ where: { id: card.id } });
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.masterCardId).toBeNull();
  });

  it('AC3: master cards never appear in /products, /products/:id or facets', async () => {
    const pBefore = await request(app.getHttpServer())
      .get('/api/v1/products?limit=1')
      .expect(200);
    const fBefore = await request(app.getHttpServer())
      .get('/api/v1/catalog/facets')
      .expect(200);
    const card = await mkCard('vis');
    const pAfter = await request(app.getHttpServer())
      .get('/api/v1/products?limit=1')
      .expect(200);
    const fAfter = await request(app.getHttpServer())
      .get('/api/v1/catalog/facets')
      .expect(200);
    expect(pAfter.body).toEqual(pBefore.body);
    expect(fAfter.body).toEqual(fBefore.body);
    await request(app.getHttpServer())
      .get(`/api/v1/products/${card.id}`)
      .expect(404);
  });

  it('AC5: without TCGAPI_KEY the injected client is the fake', () => {
    const key = app.get(ConfigService).get<string>('TCGAPI_KEY');
    expect(key).toBeFalsy();
    const client = app.get<TcgApiClient>(TCG_API_CLIENT);
    expect(client.provider).toBe('FAKE');
    expect(client).toBe(app.get(FakeTcgApiClient));
  });
});
