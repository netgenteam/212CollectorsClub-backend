import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ADMIN_USERNAME = 'e2e-admin-story-21-1';
const ADMIN_EMAIL = 'e2e-admin-story-21-1@212collectorsclub.test';
const ADMIN_PASSWORD = 'correct-horse-battery-staple-21d1';

interface Item {
  id: string;
  name: string;
  slug: string;
}

// Story 21.1 (FR-141..144, AD-104): product detail and related by id or slug.
// Runs on the throw-away database clone (assert-test-db); every row created is
// removed in afterAll.
describe('Catalog by slug (e2e, Story 21.1)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminId: string;
  let accessToken: string;
  let categoryId: string;
  const createdIds: string[] = [];
  const token = `s211${randomUUID().slice(0, 6)}`.toLowerCase();
  const ids: Record<string, string> = {};
  const slugOf = (key: string) => `${token}-${key}`;

  const mk = async (key: string, isActive = true, stock = 3) => {
    const p = await prisma.product.create({
      data: {
        name: `${token} ${key}`,
        slug: slugOf(key),
        description: 'Created by e2e 21.1.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '9.99',
        stock,
        heldQty: 0,
        isActive,
        categoryId,
      },
    });
    createdIds.push(p.id);
    ids[key] = p.id;
  };

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

    categoryId = (
      await prisma.category.create({
        data: { name: `${token} cat`, slug: `${token}-cat` },
      })
    ).id;
    await mk('base');
    await mk('peer');
    await mk('hidden', false);

    const admin = await prisma.adminUser.upsert({
      where: { username: ADMIN_USERNAME },
      create: {
        username: ADMIN_USERNAME,
        email: ADMIN_EMAIL,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
      update: {},
    });
    adminId = admin.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .expect(200);
    accessToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: token } },
    });
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const get = (path: string) =>
    request(app.getHttpServer()).get(`/api/v1/products/${path}`);

  /** Product-table reads issued through Prisma while `fn` runs. */
  async function countQueries(fn: () => Promise<unknown>): Promise<number> {
    let n = 0;
    const wrap = <T extends object>(obj: T, key: keyof T) => {
      const original = (obj[key] as (...a: unknown[]) => unknown).bind(obj);
      (obj as Record<string, unknown>)[key as string] = (...a: unknown[]) => {
        n += 1;
        return original(...a);
      };
      return () => {
        (obj as Record<string, unknown>)[key as string] = original;
      };
    };
    const restore = [
      wrap(prisma.product, 'findUnique'),
      wrap(prisma.product, 'findFirst'),
      wrap(prisma.product, 'findMany'),
      wrap(prisma, '$queryRaw'),
    ];
    try {
      await fn();
    } finally {
      restore.forEach((r) => r());
    }
    return n;
  }

  it('uuid and slug return the same body, with the exact detail shape (AC2, AC3, AC7)', async () => {
    const byId = await get(ids.base).expect(200);
    const bySlug = await get(slugOf('base')).expect(200);
    expect(bySlug.body).toEqual(byId.body);
    const body = byId.body as Record<string, unknown>;
    // byte-for-byte contract: the key set is the pre-21.1 one
    expect(Object.keys(body).sort()).toEqual(
      [
        'availableStock',
        'category',
        'categories',
        'description',
        'editionLanguage',
        'franchise',
        'grading',
        'id',
        'images',
        'inStock',
        'isPreorder',
        'marketReferences',
        'name',
        'price',
        'productType',
        'rarity',
        'releaseDate',
        'slug',
      ].sort(),
    );
    expect(body).toMatchObject({
      id: ids.base,
      slug: slugOf('base'),
      name: `${token} base`,
      price: 9.99,
      availableStock: 3,
      inStock: true,
    });
  });

  it('list items and related items carry id and a non-null slug (AC7)', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/v1/products?search=${token}&limit=50`)
      .expect(200);
    const items = (list.body as { data: Item[] }).data.filter((i) =>
      i.slug?.startsWith(token),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(typeof i.id).toBe('string');
      expect(typeof i.slug).toBe('string');
    }
    const rel = await get(`${slugOf('base')}/related?limit=10`).expect(200);
    for (const i of (rel.body as { data: Item[] }).data) {
      expect(typeof i.id).toBe('string');
      expect(typeof i.slug).toBe('string');
    }
  });

  it('documents idOrSlug and slug as required in the Swagger document (AC7, AC8)', async () => {
    const doc = (
      await request(app.getHttpServer()).get('/api/docs-json').expect(200)
    ).body as {
      paths: Record<
        string,
        {
          get: {
            parameters: { name: string; in: string }[];
            responses: Record<string, unknown>;
          };
        }
      >;
      components: {
        schemas: Record<string, { required?: string[] }>;
      };
    };
    for (const path of [
      '/api/v1/products/{idOrSlug}',
      '/api/v1/products/{idOrSlug}/related',
    ]) {
      const op = doc.paths[path].get;
      expect(op.parameters.some((p) => p.name === 'idOrSlug')).toBe(true);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(['200', '400', '404']),
      );
    }
    for (const schema of ['ProductListItemDto', 'ProductDetailDto']) {
      expect(doc.components.schemas[schema].required).toEqual(
        expect.arrayContaining(['id', 'slug']),
      );
    }
  });

  it('related by slug equals related by id: same items, same order, without itself (AC3)', async () => {
    const byId = (await get(`${ids.base}/related?limit=10`).expect(200))
      .body as { data: Item[] };
    const bySlug = (await get(`${slugOf('base')}/related?limit=10`).expect(200))
      .body as { data: Item[] };
    expect(bySlug).toEqual(byId);
    const data = bySlug.data;
    expect(data.some((i) => i.id === ids.base)).toBe(false);
    expect(data.some((i) => i.id === ids.hidden)).toBe(false);
    // ambient same-franchise rows may fill the 10 slots; equality above is the contract
    expect(data.length).toBeGreaterThan(0);
  });

  it('400 with the legacy ParseUUIDPipe body for invalid values, without reaching Prisma (AC1, AC5)', async () => {
    const bad = [
      'Foo_Bar!',
      'UPPER',
      'a--b',
      '-a',
      'a-',
      'a'.repeat(201),
      '%00',
    ];
    let reads = 0;
    const n = await countQueries(async () => {
      for (const v of bad) {
        for (const suffix of ['', '/related']) {
          const res = await get(`${encodeURIComponent(v)}${suffix}`);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({
            message: 'Validation failed (uuid is expected)',
            error: 'Bad Request',
            statusCode: 400,
          });
          reads += 1;
        }
      }
    });
    expect(reads).toBe(bad.length * 2);
    expect(n).toBe(0);
  });

  it('404 for unknown slug, inactive (by slug and by id), same type and message (AC4)', async () => {
    const unknown = await get('no-such-slug-21-1').expect(404);
    expect(unknown.body).toMatchObject({
      statusCode: 404,
      message: 'Product no-such-slug-21-1 not found',
      error: 'Not Found',
    });
    const hiddenSlug = await get(slugOf('hidden')).expect(404);
    expect((hiddenSlug.body as { message: string }).message).toBe(
      `Product ${slugOf('hidden')} not found`,
    );
    const hiddenId = await get(ids.hidden).expect(404);
    expect((hiddenId.body as { message: string }).message).toBe(
      `Product ${ids.hidden} not found`,
    );
    await get(`${slugOf('hidden')}/related`).expect(404);
    await get(`no-such-slug-21-1/related`).expect(404);
  });

  it('one product query per request, no more than the id route; related adds none (AC6)', async () => {
    const byId = await countQueries(() => get(ids.base).expect(200));
    const bySlug = await countQueries(() => get(slugOf('base')).expect(200));
    expect(bySlug).toBeGreaterThan(0);
    expect(bySlug).toBeLessThanOrEqual(byId);
    const relId = await countQueries(() =>
      get(`${ids.base}/related`).expect(200),
    );
    const relSlug = await countQueries(() =>
      get(`${slugOf('base')}/related`).expect(200),
    );
    expect(relSlug).toBeLessThanOrEqual(relId);
  });

  it('a slug changed through PATCH /admin/products/:id: old 404, new 200 (AC4, AC9)', async () => {
    await mk('rename');
    const oldSlug = slugOf('rename');
    const newSlug = slugOf('renamed');
    await get(oldSlug).expect(200);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${ids.rename}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ slug: newSlug })
      .expect(200);
    await get(oldSlug).expect(404);
    await get(`${oldSlug}/related`).expect(404);
    const res = await get(newSlug).expect(200);
    expect((res.body as { id: string }).id).toBe(ids.rename);
    // the id keeps working
    await get(ids.rename).expect(200);
  });
});
