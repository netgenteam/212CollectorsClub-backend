import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { TCG_API_CLIENT } from './../src/tcg/tcg-api-client.interface.js';

type App = Parameters<typeof request>[0];
type Item = {
  id: string;
  name: string;
  externalId: string;
  apiPriceUsd: number | null;
  alreadyInInventory: boolean;
  currentInventoryStock: number;
};
type Body = { data: Item[]; meta: Record<string, unknown> };

const PREFIX = 'e2e155-';
const ADMIN_USER = 'e2e155-admin';
const ADMIN_PASSWORD = 'E2e155-Pass-123!';
const SEARCH = '/api/v1/admin/tcg-master-cards/search';

/**
 * Story 15.5 (FR-68, AD-56): admin master card search. Rows use the
 * `e2e155-` prefix; the TCG client is spied to prove no API call is made.
 */
describe('Admin master card search (e2e, Story 15.5)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  const tcgSpy = { listSets: vi.fn(), listSetCards: vi.fn() };
  const server = () => app.getHttpServer();
  const get = (qs: string) =>
    request(server())
      .get(`${SEARCH}?${qs}`)
      .set('Authorization', `Bearer ${token}`);

  const mk = (
    n: string,
    over: {
      name: string;
      setId?: string;
      setName?: string;
      number?: string | null;
      price?: string | null;
      franchise?: 'POKEMON' | 'MAGIC_THE_GATHERING';
    },
  ) =>
    prisma.masterCard.create({
      data: {
        externalProvider: 'FAKE',
        externalId: `${PREFIX}${n}`,
        name: over.name,
        cleanName: over.name.toLowerCase(),
        searchText:
          `${over.name} ${over.setName ?? 'E2E Set'} ${over.number ?? ''}`
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim(),
        franchise: over.franchise ?? 'POKEMON',
        gameSlug: 'pokemon',
        setId: over.setId ?? `${PREFIX}set1`,
        setName: over.setName ?? 'E2E Set',
        cardNumber: over.number ?? null,
        marketPriceUsd: over.price === undefined ? '1.00' : over.price,
        rawApiData: { id: n },
      },
    });

  async function mkProduct(masterCardId: string, stock: number, active = true) {
    const category = await prisma.category.findFirstOrThrow();
    return prisma.product.create({
      data: {
        name: `E2E155 ${stock}`,
        slug: `${PREFIX}p-${Math.random().toString(36).slice(2, 10)}`,
        description: 'e2e',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        priceUsd: '2.00',
        stock,
        isActive: active,
        categoryId: category.id,
        masterCardId,
      },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TCG_API_CLIENT)
      .useValue({ provider: 'FAKE', ...tcgSpy })
      .compile();
    app = moduleFixture.createNestApplication();
    const config = app.get(ConfigService);
    app.use(cookieParser(config.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.adminUser.create({
      data: {
        username: ADMIN_USER,
        email: `${ADMIN_USER}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    const login = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: ADMIN_USER, password: ADMIN_PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.masterCard.deleteMany({
      where: { externalId: { startsWith: PREFIX } },
    });
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: ADMIN_USER } });
    await app.close();
  });

  it('AC1: 401 without or with an invalid token', async () => {
    await request(server()).get(SEARCH).expect(401);
    await request(server())
      .get(SEARCH)
      .set('Authorization', 'Bearer nope')
      .expect(401);
  });

  it('AC2: multi-token, accent-insensitive and "/" number search', async () => {
    await mk('a', {
      name: 'Charizard ex',
      number: '199/165',
      setName: 'E2E Scarlet',
    });
    await mk('b', {
      name: 'Charizard ex',
      number: '006/165',
      setName: 'E2E Scarlet',
    });
    await mk('c', { name: 'Pikáchu', number: '25' });
    await mk('d', { name: 'Pikachu', number: '26' });

    const r = await get('q=charizard%20ex%20199/165').expect(200);
    const rows = (r.body as Body).data.filter((i) =>
      i.externalId.startsWith(PREFIX),
    );
    expect(rows.map((i) => i.externalId)).toEqual([`${PREFIX}a`]);

    const p = await get('q=pikachu&set=e2e').expect(200);
    expect((p.body as Body).data.map((i) => i.externalId).sort()).toEqual([
      `${PREFIX}c`,
      `${PREFIX}d`,
    ]);
    const acc = await get('q=pik%C3%A1chu&set=e2e').expect(200);
    expect((acc.body as Body).meta.total).toBe(2);
  });

  it('AC3: franchise/set filters are ANDed; invalid franchise is 400', async () => {
    await mk('a', {
      name: 'Zzfilter',
      setId: `${PREFIX}sA`,
      setName: 'Alpha Set',
    });
    await mk('b', {
      name: 'Zzfilter',
      setId: `${PREFIX}sB`,
      setName: 'Beta Set',
    });
    await mk('c', { name: 'Zzfilter', franchise: 'MAGIC_THE_GATHERING' });

    const bySetId = await get(`q=zzfilter&set=${PREFIX}sA`).expect(200);
    expect((bySetId.body as Body).data.map((i) => i.externalId)).toEqual([
      `${PREFIX}a`,
    ]);
    const byName = await get('q=zzfilter&franchise=POKEMON&set=beta').expect(
      200,
    );
    expect((byName.body as Body).data.map((i) => i.externalId)).toEqual([
      `${PREFIX}b`,
    ]);
    const mtg = await get('q=zzfilter&franchise=MAGIC_THE_GATHERING').expect(
      200,
    );
    expect((mtg.body as Body).data.map((i) => i.externalId)).toEqual([
      `${PREFIX}c`,
    ]);
    await get('franchise=NOPE').expect(400);
  });

  it('AC4: limit 51 -> 400; defaults limit=20, page=1', async () => {
    await get('limit=51').expect(400);
    await get('limit=0').expect(400);
    await get('page=0').expect(400);
    const r = await get('q=zzdefaults').expect(200);
    expect((r.body as Body).meta).toMatchObject({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it('AC5/AC6: response shape, numeric/null price and inventory aggregation', async () => {
    const a = await mk('a', { name: 'Zzinv', price: '12.50' });
    await mk('b', { name: 'Zzinv', price: null });
    await mkProduct(a.id, 3);
    await mkProduct(a.id, 4, false);

    const r = await get('q=zzinv').expect(200);
    const body = r.body as Body;
    expect(body.meta).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    expect(Object.keys(body.data[0]).sort()).toEqual(
      [
        'id',
        'externalId',
        'name',
        'franchise',
        'setId',
        'setName',
        'cardNumber',
        'rarity',
        'printing',
        'editionLanguage',
        'imageSmall',
        'imageLarge',
        'apiPriceUsd',
        'alreadyInInventory',
        'currentInventoryStock',
      ].sort(),
    );
    expect(body.data[0]).toMatchObject({
      externalId: `${PREFIX}a`,
      apiPriceUsd: 12.5,
      alreadyInInventory: true,
      currentInventoryStock: 7,
    });
    expect(body.data[1]).toMatchObject({
      externalId: `${PREFIX}b`,
      apiPriceUsd: null,
      alreadyInInventory: false,
      currentInventoryStock: 0,
    });
  });

  it('AC7: exactly one product.groupBy per page, count+data otherwise', async () => {
    for (let i = 0; i < 6; i++)
      await mk(`n${i}`, { name: 'Zzn1', price: `${i + 1}.00` });
    const spy = vi.spyOn(prisma.product, 'groupBy');
    const countSpy = vi.spyOn(prisma.masterCard, 'count');
    const findSpy = vi.spyOn(prisma.masterCard, 'findMany');
    await get('q=zzn1&limit=50').expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    countSpy.mockRestore();
    findSpy.mockRestore();
  });

  it('AC8: deterministic order (price DESC NULLS LAST, name, id) and non-overlapping pages', async () => {
    await mk('a', { name: 'Zzord B', price: '5.00' });
    await mk('b', { name: 'Zzord A', price: '5.00' });
    await mk('c', { name: 'Zzord C', price: null });
    await mk('d', { name: 'Zzord D', price: '9.00' });

    const full = await get('q=zzord').expect(200);
    expect((full.body as Body).data.map((i) => i.externalId)).toEqual([
      `${PREFIX}d`,
      `${PREFIX}b`,
      `${PREFIX}a`,
      `${PREFIX}c`,
    ]);
    const p1 = await get('q=zzord&limit=2&page=1').expect(200);
    const p2 = await get('q=zzord&limit=2&page=2').expect(200);
    const ids = [...(p1.body as Body).data, ...(p2.body as Body).data].map(
      (i) => i.id,
    );
    expect(new Set(ids).size).toBe(4);
    expect((p2.body as Body).meta).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: true,
    });
    const again = await get('q=zzord').expect(200);
    expect((again.body as Body).data.map((i) => i.id)).toEqual(
      (full.body as Body).data.map((i) => i.id),
    );
  });

  it('AC9: no tcgapi call and master cards stay out of the public catalog', async () => {
    await mk('a', { name: 'Zzpublic' });
    await get('q=zzpublic').expect(200);
    expect(tcgSpy.listSets).not.toHaveBeenCalled();
    expect(tcgSpy.listSetCards).not.toHaveBeenCalled();
    const pub = await request(server())
      .get('/api/v1/products?search=zzpublic')
      .expect(200);
    expect((pub.body as Body).data).toHaveLength(0);
    await request(server())
      .get('/api/v1/admin/tcg-master-cards/search')
      .expect(401);
    await request(server()).get('/api/v1/tcg-master-cards/search').expect(404);
  });

  it('Story 15.6: exposes printing and treats % and _ in set literally', async () => {
    await mk('p1', { name: 'Printy', setName: 'Set 100% Real_X' });
    await mk('p2', { name: 'Printy Other', setName: 'Set 100 Realtor' });
    await prisma.masterCard.updateMany({
      where: { externalId: `${PREFIX}p1` },
      data: { printing: 'Foil' },
    });
    const res = await get('q=printy');
    const body = res.body as {
      data: Array<Item & { printing: string | null }>;
    };
    expect(
      body.data.find((d) => d.externalId === `${PREFIX}p1`)?.printing,
    ).toBe('Foil');
    expect(
      body.data.find((d) => d.externalId === `${PREFIX}p2`)?.printing,
    ).toBeNull();
    const lit = (await get(`set=${encodeURIComponent('100% Real_X')}`))
      .body as Body;
    expect(lit.data.map((d) => d.externalId)).toEqual([`${PREFIX}p1`]);
    const wild = (await get(`q=printy&set=${encodeURIComponent('%')}`))
      .body as Body;
    // Literal '%': only the set whose name really contains it.
    expect(wild.data.map((d) => d.externalId)).toEqual([`${PREFIX}p1`]);
    const under = (await get(`q=printy&set=${encodeURIComponent('Real_')}`))
      .body as Body;
    expect(under.data.map((d) => d.externalId)).toEqual([`${PREFIX}p1`]);
  });

  it('AC10: Swagger documents the endpoint DTOs', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const op = doc.paths['/api/v1/admin/tcg-master-cards/search']?.get;
    expect(op).toBeDefined();
    expect(
      op?.parameters?.map((p) => ('name' in p ? p.name : '')).sort(),
    ).toEqual(['franchise', 'limit', 'page', 'q', 'set']);
    expect(doc.components?.schemas).toHaveProperty(
      'MasterCardSearchResponseDto',
    );
    expect(doc.components?.schemas).toHaveProperty('MasterCardSearchItemDto');
  });
});
