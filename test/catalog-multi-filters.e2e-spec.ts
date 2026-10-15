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

interface Item {
  id: string;
  name: string;
}
interface ListBody {
  data: Item[];
  meta: { total: number; totalPages: number; page: number };
}

// Story 13.6 (FR-51, AD-36): multi-value filters, language, category descendants.
describe('Catalog multi-value filters (e2e, Story 13.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const token = randomUUID().slice(0, 8);
  const byName: Record<string, string> = {};
  let P: string; // parent (root)
  let C: string; // child
  let G: string; // grandchild (inactive)
  let Q: string; // second root
  let X: string; // cycle a
  let Y: string; // cycle b

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

    const cat = async (
      n: string,
      parentId: string | null,
      isActive = true,
      type: 'ROOT' | 'SUBCATEGORY' = parentId ? 'SUBCATEGORY' : 'ROOT',
    ) => {
      const c = await prisma.category.create({
        data: {
          name: `${token}-${n}`,
          slug: `${token}-${n}`.toLowerCase(),
          type,
          parentId,
          isActive,
          dimension: type === 'ROOT' ? null : 'CUSTOM',
        },
      });
      categoryIds.push(c.id);
      return c.id;
    };
    P = await cat('p', null);
    C = await cat('c', P);
    G = await cat('g', C, false);
    Q = await cat('q', null);

    const mk = async (
      n: string,
      franchise: 'POKEMON' | 'ONE_PIECE' | 'YU_GI_OH',
      editionLanguage: 'JP' | 'EN' | 'ES',
      categoryId: string,
      stock: number,
      tags: string[] = [],
      productType: 'BOOSTER_BOX' | 'SINGLE_CARD' = 'BOOSTER_BOX',
    ) => {
      const p = await prisma.product.create({
        data: {
          name: `${token} ${n}`,
          slug: `${token}-${n}`.toLowerCase(),
          description: 'e2e 13.6',
          franchise,
          productType,
          rarity: 'COMMON',
          editionLanguage,
          priceUsd: '9.99',
          stock,
          categoryId,
          taxonomyTags: { create: tags.map((categoryId) => ({ categoryId })) },
        },
      });
      productIds.push(p.id);
      byName[n] = p.id;
    };
    // a: main=Q, tagged G (grandchild of P) AND C -> must appear once for P
    await mk('a', 'POKEMON', 'JP', Q, 5, [G, C]);
    await mk('b', 'ONE_PIECE', 'JP', Q, 0, [G]);
    await mk('c', 'YU_GI_OH', 'EN', Q, 5, [G]);
    await mk('d', 'POKEMON', 'ES', C, 5); // main in child
    await mk('e', 'POKEMON', 'JP', Q, 5, [], 'SINGLE_CARD'); // unrelated
    await mk('f', 'ONE_PIECE', 'EN', P, 5); // main = P itself

    // cycle fixture, inserted bypassing the service
    X = await cat('x', null, true, 'SUBCATEGORY');
    Y = await cat('y', X);
    await prisma.$executeRaw`UPDATE "Categories" SET "parentId" = ${Y}::uuid WHERE id = ${X}::uuid`;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.$executeRaw`UPDATE "Categories" SET "parentId" = NULL WHERE id = ${X}::uuid`;
    // children first
    for (const id of [Y, X, G, C, Q, P]) {
      await prisma.category.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  const get = (qs: string) =>
    request(app.getHttpServer()).get(`/api/v1/products?limit=100&${qs}`);
  const names = (b: ListBody) =>
    b.data
      .map((i) => i.name.replace(`${token} `, ''))
      .sort()
      .join(',');
  const cats = (...ids: string[]) =>
    ids.map((i) => `categoryId=${i}`).join('&');

  it('single franchise value behaves as before', async () => {
    const r = await get('franchise=POKEMON').expect(200);
    const b = r.body as ListBody;
    expect(b.data.every((i) => i.name.length > 0)).toBe(true);
    expect(b.meta.total).toBe(
      await prisma.product.count({
        where: { isActive: true, franchise: 'POKEMON' },
      }),
    );
  });

  it('repeated franchise is OR; categoryId scopes to fixtures', async () => {
    const r = await get(
      `franchise=POKEMON&franchise=ONE_PIECE&${cats(Q, P)}`,
    ).expect(200);
    const b = r.body as ListBody;
    expect(names(b)).toBe('a,b,d,e,f');
    expect(b.meta.total).toBe(5);
  });

  it('language OR and AND with franchise/inStock', async () => {
    const r = await get(
      `${cats(Q)}&language=JP&language=EN&franchise=POKEMON&franchise=ONE_PIECE&onlyInStock=true`,
    ).expect(200);
    expect(names(r.body as ListBody)).toBe('a,e');
    const es = await get(`${cats(P)}&language=ES`).expect(200);
    expect(names(es.body as ListBody)).toBe('d');
  });

  it('invalid language (lowercase / unknown) gives 400', async () => {
    await get('language=jp').expect(400);
    await get('language=FR').expect(400);
  });

  it('categoryId includes descendants (main or tag), no duplicates', async () => {
    const r = await get(cats(P)).expect(200);
    const b = r.body as ListBody;
    // a (tags G+C), b, c (tag G), d (main C), f (main P)
    expect(names(b)).toBe('a,b,c,d,f');
    expect(b.meta.total).toBe(5);
  });

  it('leaf category does not return products of ancestors; inactive subtree matches', async () => {
    const r = await get(cats(G)).expect(200);
    expect(names(r.body as ListBody)).toBe('a,b,c');
    const c = await get(cats(C)).expect(200);
    expect(names(c.body as ListBody)).toBe('a,b,c,d');
  });

  it('two categoryId are a union; AND with franchise', async () => {
    const r = await get(cats(G, Q)).expect(200);
    expect(names(r.body as ListBody)).toBe('a,b,c,e');
    const f = await get(`${cats(G, Q)}&franchise=POKEMON`).expect(200);
    expect(names(f.body as ListBody)).toBe('a,e');
  });

  it('invalid values give 400', async () => {
    await get('categoryId=not-a-uuid').expect(400);
    await get('franchise=NOPE').expect(400);
    await get('productType=NOPE').expect(400);
    await get('franchise=').expect(400);
    await get('language=').expect(400);
    await get('categoryId=').expect(400);
    const many = (k: string, v: string, n: number) =>
      Array.from({ length: n }, () => `${k}=${v}`).join('&');
    await get(many('franchise', 'POKEMON', 21)).expect(400);
    await get(many('language', 'JP', 21)).expect(400);
    await get(many('categoryId', randomUUID(), 21)).expect(400);
    await get(many('productType', 'BOOSTER_BOX', 11)).expect(400);
    await get(many('franchise', 'POKEMON', 20)).expect(200);
    await get(many('categoryId', randomUUID(), 20)).expect(200);
  });

  it('injection attempts are rejected or inert', async () => {
    await get(`categoryId=${encodeURIComponent("x' OR '1'='1")}`).expect(400);
    await get(
      `language=${encodeURIComponent('JP\');DROP TABLE "Products";--')}`,
    ).expect(400);
    await get(
      `franchise=${encodeURIComponent('POKEMON\';DROP TABLE "Products";--')}`,
    ).expect(400);
    const q = await get('search=%25').expect(200);
    expect((q.body as ListBody).meta.total).toBeGreaterThanOrEqual(0);
    expect(await prisma.product.count()).toBeGreaterThan(0);
  });

  it('bracket form is ignored (200), as productType[] today', async () => {
    const all = (await get('').expect(200)).body as ListBody;
    for (const k of [
      'productType[]=BOOSTER_BOX',
      'franchise[]=POKEMON',
      'language[]=JP',
    ]) {
      const r = await get(k).expect(200);
      expect((r.body as ListBody).meta.total).toBe(all.meta.total);
    }
  });

  it('cycle in the tree terminates with 200', async () => {
    await get(cats(X)).expect(200);
  });

  it('meta.total equals items across all pages with new filters', async () => {
    const qs = `${cats(P, Q)}&language=JP&language=EN&language=ES`;
    const first = (
      await request(app.getHttpServer())
        .get(`/api/v1/products?${qs}&limit=2&page=1`)
        .expect(200)
    ).body as ListBody;
    let count = 0;
    const seen = new Set<string>();
    for (let p = 1; p <= first.meta.totalPages; p++) {
      const r = (
        await request(app.getHttpServer())
          .get(`/api/v1/products?${qs}&limit=2&page=${p}`)
          .expect(200)
      ).body as ListBody;
      count += r.data.length;
      r.data.forEach((i) => seen.add(i.id));
    }
    expect(first.meta.total).toBe(6);
    expect(count).toBe(first.meta.total);
    expect(seen.size).toBe(count);
  });

  it('productType repeated keys and macroCategory still work (AD-19)', async () => {
    const r = await get(
      `${cats(Q)}&productType=SINGLE_CARD&productType=BOOSTER_BOX`,
    ).expect(200);
    expect(names(r.body as ListBody)).toBe('a,b,c,e');
    const m = await get(`${cats(Q)}&macroCategory=SINGLES`).expect(200);
    expect(names(m.body as ListBody)).toBe('e');
  });
});
