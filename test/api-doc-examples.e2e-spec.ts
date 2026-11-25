import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SIMULATOR_IMAGES_DIR } from './../src/admin-catalog/product-image-upload-paths.constants.js';

/**
 * Story 22.9 (AC2, AC3): `docs/api-simulator-manual-sets.md` is executed against the real system. Examples are the
 * fenced blocks right after `<!-- example: <id> [mode=shape] -->`; the route table and the errorCode catalog are
 * parsed too. If the document and the behaviour diverge, this suite fails.
 */
type App = Parameters<typeof request>[0];
const DOC = readFileSync('docs/api-simulator-manual-sets.md', 'utf8');
const USER = 'e2e-admin-story-22-9-doc';
const EMAIL = 'e2e-admin-story-22-9-doc@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-9-doc';
const BASE = '/api/v1/admin/simulator/manual-sets';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const SET_NAME = 'Mi set de prueba';

interface Example {
  lang: string;
  body: string;
  shape: boolean;
}
const examples = new Map<string, Example>();
for (const m of DOC.matchAll(
  /<!-- example: ([a-z0-9-]+)( mode=shape)? -->\n```(\w+)\n([\s\S]*?)\n```/g,
))
  examples.set(m[1], { lang: m[3], body: m[4], shape: Boolean(m[2]) });
const ex = (id: string): unknown => {
  const e = examples.get(id);
  if (!e) throw new Error(`doc example "${id}" not found`);
  return JSON.parse(e.body);
};
const exText = (id: string): string => {
  const e = examples.get(id);
  if (!e) throw new Error(`doc example "${id}" not found`);
  return e.body + '\n';
};

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ISO_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const placeholderRe = (s: string): RegExp =>
  new RegExp(
    '^' +
      escapeRe(s)
        .replace(/<uuid>/g, UUID_RE)
        .replace(/<iso>/g, ISO_RE) +
      '$',
    'i',
  );

/** Returns a list of mismatches ([] = the actual value fits the documented example). */
function diff(
  example: unknown,
  actual: unknown,
  shape: boolean,
  path = '$',
): string[] {
  if (typeof example === 'string' && /<(uuid|iso)>/.test(example))
    return typeof actual === 'string' && placeholderRe(example).test(actual)
      ? []
      : [`${path}: ${JSON.stringify(actual)} does not fit ${example}`];
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) return [`${path}: not an array`];
    const open =
      typeof example[example.length - 1] === 'string' &&
      (example[example.length - 1] as string).startsWith('<...');
    const head = open ? example.slice(0, -1) : example;
    if (open ? actual.length < head.length : actual.length !== head.length)
      return [`${path}: length ${actual.length} vs ${head.length}`];
    return head.flatMap((e, i) => diff(e, actual[i], shape, `${path}[${i}]`));
  }
  if (example !== null && typeof example === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual))
      return [`${path}: not an object`];
    const ek = Object.keys(example).sort();
    const ak = Object.keys(actual).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ak))
      return [`${path}: keys ${ak.join(',')} vs documented ${ek.join(',')}`];
    return ek.flatMap((k) =>
      diff(
        (example as Record<string, unknown>)[k],
        (actual as Record<string, unknown>)[k],
        shape,
        `${path}.${k}`,
      ),
    );
  }
  if (shape)
    return typeof example === typeof actual ||
      example === null ||
      actual === null
      ? []
      : [`${path}: type ${typeof actual} vs ${typeof example}`];
  return JSON.stringify(example) === JSON.stringify(actual)
    ? []
    : [
        `${path}: ${JSON.stringify(actual)} vs documented ${JSON.stringify(example)}`,
      ];
}

describe('API contract document (e2e, Story 22.9 AC2/AC3)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let swagger: {
    paths: Record<string, Record<string, { deprecated?: boolean }>>;
  };
  const urls: string[] = [];
  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const fits = (id: string, actual: unknown) =>
    expect(diff(ex(id), actual, examples.get(id)!.shape), id).toEqual([]);
  const csv = (s: string) => Buffer.from(s);
  const importCsv = (setId: string, body: Buffer, q = '') =>
    server()
      .post(`${BASE}/${setId}/cards/import${q}`)
      .set(auth())
      .attach('file', body, { filename: 'c.csv', contentType: 'text/csv' });
  const mkSet = async (body: object): Promise<string> =>
    (
      (await server().post(BASE).set(auth()).send(body).expect(201)).body as {
        id: string;
      }
    ).id;

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
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
    // names used by the document must be free (throw-away database, but be explicit)
    await prisma.simulatorSet.deleteMany({
      where: {
        nameKey: {
          in: [
            SET_NAME.toLowerCase(),
            'orden dos',
            'doc 22.9 por defecto',
            'doc 22.9 por defecto x',
            'doc 22.9 por defecto y',
            'doc 22.9 por defecto z',
            'doc 22.9 por defecto w',
            'doc 22.9 por defecto v',
            'doc 22.9 limite',
          ],
        },
      },
    });
    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    await prisma.adminUser.upsert({
      where: { username: USER },
      create: { username: USER, email: EMAIL, passwordHash },
      update: { email: EMAIL, passwordHash },
    });
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
    swagger = (await server().get('/api/docs-json')).body as typeof swagger;
  });

  afterAll(async () => {
    await prisma.simulatorSet.deleteMany({
      where: {
        nameKey: {
          in: [
            SET_NAME.toLowerCase(),
            'orden dos',
            'doc 22.9 por defecto',
            'doc 22.9 por defecto x',
            'doc 22.9 por defecto y',
            'doc 22.9 por defecto z',
            'doc 22.9 por defecto w',
            'doc 22.9 por defecto v',
            'doc 22.9 limite',
          ],
        },
      },
    });
    await Promise.all(
      urls.map((u) =>
        rm(join(SIMULATOR_IMAGES_DIR, u.split('/').pop()!), { force: true }),
      ),
    );
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  describe('AC3: routes of the document vs Swagger', () => {
    const rows = [
      ...DOC.matchAll(
        /^\| `(GET|POST|PATCH|PUT|DELETE) (\/api\/v1\/[^`\s]+)`/gm,
      ),
    ].map((m) => [m[1].toLowerCase(), m[2].replace(/:(\w+)/g, '{$1}')]);

    it('documents the 13 live routes and the 4 deprecated ones', () => {
      expect(rows.length).toBe(17);
    });

    it('every documented route exists in /api/docs-json', () => {
      for (const [method, path] of rows)
        expect(
          swagger.paths[path]?.[method],
          `${method} ${path}`,
        ).toBeDefined();
    });

    it('every manual-sets / simulator route of Swagger is documented, and the deprecated ones are listed in section 9', () => {
      const documented = new Set(rows.map(([m, p]) => `${m} ${p}`));
      for (const [path, ops] of Object.entries(swagger.paths))
        for (const [method, op] of Object.entries(ops)) {
          if (
            !/\/admin\/simulator\/(manual-sets|images)|\/api\/v1\/simulator\//.test(
              path,
            )
          )
            continue;
          expect(documented.has(`${method} ${path}`), `${method} ${path}`).toBe(
            true,
          );
          expect(op.deprecated ?? false).toBe(false);
        }
      const s9 = DOC.slice(DOC.indexOf('## 9. Endpoints `deprecated`'));
      for (const [path, ops] of Object.entries(swagger.paths))
        for (const [method, op] of Object.entries(ops))
          if (op.deprecated && /simulator|pack_simulator/.test(path))
            expect(
              s9.includes(
                `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
              ),
              `${method} ${path}`,
            ).toBe(true);
    });

    it('every errorCode of the catalog appears in the Swagger descriptions of the simulator routes', () => {
      const sim = JSON.stringify(
        Object.entries(swagger.paths)
          .filter(([p]) => /simulator\//.test(p))
          .map(([, v]) => v),
      );
      for (const code of catalogCodes())
        if (code !== 'INVALID_ADMIN_TOKEN') expect(sim, code).toContain(code);
    });
  });

  function catalogCodes(): string[] {
    const part = DOC.slice(
      DOC.indexOf('<!-- catalog:start -->'),
      DOC.indexOf('<!-- catalog:end -->'),
    );
    return [...part.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm)].map(
      (m) => m[1],
    );
  }
  const catalogStatus = (code: string): number => {
    const part = DOC.slice(
      DOC.indexOf('<!-- catalog:start -->'),
      DOC.indexOf('<!-- catalog:end -->'),
    );
    return Number(
      new RegExp(`^\\| \`${code}\` \\| (\\d{3}) \\|`, 'm').exec(part)![1],
    );
  };

  describe('AC2: the admin flow of section 1 with the examples of the document', () => {
    let id: string;

    it('create => SetDto of the document', async () => {
      const r = await server()
        .post(BASE)
        .set(auth())
        .send({ name: SET_NAME })
        .expect(201);
      id = (r.body as { id: string }).id;
      fits('set-empty', r.body);
      const get = await server().get(`${BASE}/${id}`).set(auth()).expect(200);
      fits('set-empty', get.body);
      const list = await server().get(BASE).set(auth()).expect(200);
      const b = list.body as { data: unknown[]; meta: object };
      expect(Object.keys(b).sort()).toEqual(['data', 'meta']);
      expect(Object.keys(b.meta).sort()).toEqual(
        Object.keys((ex('cards-page') as { meta: object }).meta).sort(),
      );
      fits(
        'set-empty',
        b.data.find((s) => (s as { id: string }).id === id),
      );
    });

    it('image upload => {url,width,height,bytes}', async () => {
      const r = await server()
        .post('/api/v1/admin/simulator/images')
        .set(auth())
        .attach(
          'file',
          readFileSync('test/fixtures/product-image-fixture.png'),
          {
            filename: 'x.png',
            contentType: 'image/png',
          },
        )
        .expect(201);
      urls.push((r.body as { url: string }).url);
      fits('image-ok', r.body);
    });

    it('the CSV template of the document is the downloadable file and the 22.7 fixture', () => {
      const file = readFileSync('docs/cards-template.csv', 'utf8');
      expect(exText('csv-template')).toBe(file);
      expect(file).toBe(
        readFileSync('test/fixtures/cards-template.csv', 'utf8'),
      );
    });

    it('invalid CSV => 422 with exactly the errors of the document (row numbering included)', async () => {
      const r = await importCsv(id, csv(exText('csv-invalid'))).expect(422);
      fits('csv-invalid-response', r.body);
      expect(await prisma.simulatorCard.count({ where: { setId: id } })).toBe(
        0,
      );
    });

    it('dryRun then import of the template; list of cards', async () => {
      const dry = await importCsv(
        id,
        csv(exText('csv-template')),
        '?dryRun=true',
      ).expect(200);
      fits('import-dry', dry.body);
      expect(await prisma.simulatorCard.count({ where: { setId: id } })).toBe(
        0,
      );
      const ok = await importCsv(id, csv(exText('csv-template'))).expect(201);
      fits('import-ok', ok.body);
      const page = await server()
        .get(`${BASE}/${id}/cards`)
        .set(auth())
        .expect(200);
      fits('cards-page', page.body);
      fits('card', (page.body as { data: unknown[] }).data[0]);
    });

    it('rows count CSV records, not physical lines', async () => {
      const r = await importCsv(
        id,
        csv('name,rarity\n"Mr.\nMime",common\nBad,nope\n'),
        '?dryRun=true',
      ).expect(422);
      expect(
        (r.body as { details: { errors: { row: number }[] } }).details.errors,
      ).toMatchObject([{ row: 3, field: 'rarity', code: 'INVALID_RARITY' }]);
    });

    it('activate without sufficiency => 422 NOT_READY exactly as documented; public list empty and pack 404', async () => {
      const r = await server()
        .patch(`${BASE}/${id}`)
        .set(auth())
        .send({ isActive: true })
        .expect(422);
      fits('err-not-ready', r.body);
      const pub = await server().get('/api/v1/simulator/sets').expect(200);
      expect(
        (pub.body as { data: { setId: string }[] }).data.some(
          (s) => s.setId === id,
        ),
      ).toBe(false);
      await server()
        .post('/api/v1/simulator/packs')
        .send({ setId: id })
        .expect(404);
    });

    it('complete the set with a ";" + BOM CSV, activate, public list and pack match the document', async () => {
      const lines = [
        'Name;Rarity;Number;ImageUrl;MarketPriceUsd',
        ...[2, 3, 4].map((n) => `C${n};Common;${n};;0.10`),
        ...[5, 6, 7].map((n) => `U${n};Uncommon;${n};;`),
        ...[8, 9, 10].map((n) => `R${n};Rare Holo;${n};;1`),
        'UR;Ultra Rare;11;;5',
        'IR;Illustration Rare;12;;8',
        'SIR;special-illustration-rare;13;;40',
        'HR;HYPER RARE;14;;99.99',
      ];
      const body = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(lines.join('\n') + '\n'),
      ]);
      await importCsv(id, body).expect(201);
      const act = await server()
        .patch(`${BASE}/${id}`)
        .set(auth())
        .send({ isActive: true })
        .expect(200);
      expect((act.body as { readiness: unknown }).readiness).toEqual({
        ready: true,
        missing: [],
      });
      const pub = await server().get('/api/v1/simulator/sets').expect(200);
      const mine = (pub.body as { data: { setId: string }[] }).data.filter(
        (s) => s.setId === id,
      );
      expect(mine).toHaveLength(1);
      const expected = ex('public-sets') as { data: object[] };
      expect(
        diff(expected.data[0], { ...mine[0] }, false).filter(
          (d) => !d.includes('cardCount'),
        ),
      ).toEqual([]);
      expect((mine[0] as unknown as { cardCount: number }).cardCount).toBe(15);
      const pack = await server()
        .post('/api/v1/simulator/packs')
        .send({ setId: id })
        .expect(200);
      fits('pack', pack.body);
      const cards = (
        pack.body as {
          cards: {
            product: unknown;
            rarityRaw: string;
            rarityTier: string;
            id: string;
          }[];
        }
      ).cards;
      expect(cards).toHaveLength(10);
      expect(new Set(cards.map((c) => c.id)).size).toBe(10);
      for (const c of cards) {
        expect(c.product).toBeNull();
        expect(c.rarityRaw).toBe(c.rarityTier);
      }
    });

    it('old slug => 400 standard validation exactly as documented; unknown UUID => 404', async () => {
      const r = await server()
        .post('/api/v1/simulator/packs')
        .send({ setId: 'pokemon-sv3' })
        .expect(400);
      fits('err-validation', r.body);
      const nf = await server()
        .post('/api/v1/simulator/packs')
        .send({ setId: UUID0 })
        .expect(404);
      expect((nf.body as { errorCode: string }).errorCode).toBe(
        'SIMULATOR_SET_NOT_FOUND',
      );
    });
  });

  describe('AC2: readiness examples of section 4.3', () => {
    const tierRows = (spec: Record<string, number>): string =>
      'name,rarity,number\n' +
      Object.entries(spec)
        .flatMap(([t, n]) =>
          Array.from({ length: n }, (_, i) => `${t}${i},${t},${t}-${i}`),
        )
        .join('\n') +
      '\n';
    const missingOf = async (id: string): Promise<unknown> => {
      const r = await server().get(`${BASE}/${id}`).set(auth()).expect(200);
      return {
        missing: (r.body as { readiness: { missing: unknown } }).readiness
          .missing,
      };
    };

    it('example 1: default template with 9 C+U+R => reverse 10/9', async () => {
      const id = await mkSet({ name: 'doc 22.9 por defecto' });
      await importCsv(
        id,
        csv(
          tierRows({
            COMMON: 4,
            UNCOMMON: 3,
            RARE: 2,
            DOUBLE_RARE: 1,
            ULTRA_RARE: 1,
            ILLUSTRATION_RARE: 1,
            SPECIAL_ILLUSTRATION_RARE: 1,
            HYPER_RARE: 1,
          }),
        ),
      ).expect(201);
      expect(await missingOf(id)).toEqual(ex('not-ready-default'));
      await server()
        .patch(`${BASE}/${id}`)
        .set(auth())
        .send({ isActive: true })
        .expect(422);
    });

    it('example 2: reverse before fixed COMMON => 6/5 and 7/6', async () => {
      const id = await mkSet({
        name: 'orden dos',
        template: {
          slots: [
            { kind: 'reverse', count: 2 },
            { kind: 'fixed', tier: 'COMMON', count: 4 },
            { kind: 'rare', odds: { RARE: 100 } },
          ],
        },
      });
      await importCsv(id, csv(tierRows({ COMMON: 5, RARE: 1 }))).expect(201);
      expect(await missingOf(id)).toEqual(ex('not-ready-order'));
    });
  });

  describe('AC2: every errorCode of the catalog is produced with the documented status', () => {
    const body = async (r: request.Test) => {
      const res = await r;
      return {
        status: res.status,
        body: res.body as {
          errorCode?: string;
          details?: Record<string, unknown>;
        },
      };
    };
    const savedSets = process.env.SIMULATOR_MAX_SETS;
    const savedCards = process.env.SIMULATOR_MAX_CARDS_PER_SET;
    afterEach(() => {
      if (savedSets === undefined) delete process.env.SIMULATOR_MAX_SETS;
      else process.env.SIMULATOR_MAX_SETS = savedSets;
      if (savedCards === undefined)
        delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
      else process.env.SIMULATOR_MAX_CARDS_PER_SET = savedCards;
    });
    afterAll(() => {
      if (savedSets === undefined) delete process.env.SIMULATOR_MAX_SETS;
      else process.env.SIMULATOR_MAX_SETS = savedSets;
      if (savedCards === undefined)
        delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
      else process.env.SIMULATOR_MAX_CARDS_PER_SET = savedCards;
    });

    /** Codes that need a 5 s row lock: proven by admin-simulator-manual-sets.e2e-spec.ts (SET_BUSY). */
    const proven = new Set(['SIMULATOR_SET_BUSY']);

    const triggers: Record<
      string,
      () => Promise<{
        status: number;
        body: { errorCode?: string; details?: Record<string, unknown> };
      }>
    > = {
      INVALID_ADMIN_TOKEN: () => body(server().get(BASE)),
      SIMULATOR_SET_NOT_FOUND: () =>
        body(server().get(`${BASE}/${UUID0}`).set(auth())),
      SIMULATOR_CARD_NOT_FOUND: async () => {
        const id = await mkSet({ name: 'doc 22.9 por defecto x' });
        return body(
          server()
            .patch(`${BASE}/${id}/cards/${UUID0}`)
            .set(auth())
            .send({ name: 'z' }),
        );
      },
      SIMULATOR_SET_NAME_TAKEN: () =>
        body(
          server()
            .post(BASE)
            .set(auth())
            .send({ name: `  ${SET_NAME.toUpperCase()}  ` }),
        ),
      SIMULATOR_CARD_NUMBER_TAKEN: async () => {
        const id = await mkSet({ name: 'doc 22.9 por defecto y' });
        await server()
          .post(`${BASE}/${id}/cards`)
          .set(auth())
          .send({ name: 'a', rarityTier: 'COMMON', number: '7' })
          .expect(201);
        return body(
          server()
            .post(`${BASE}/${id}/cards`)
            .set(auth())
            .send({ name: 'b', rarityTier: 'COMMON', number: '7' }),
        );
      },
      SIMULATOR_SET_ACTIVE: async () => {
        const id = (
          await prisma.simulatorSet.findFirstOrThrow({
            where: { nameKey: SET_NAME.toLowerCase() },
          })
        ).id;
        return body(server().delete(`${BASE}/${id}`).set(auth()));
      },
      SIMULATOR_SET_NOT_READY: async () => {
        const id = await mkSet({ name: 'doc 22.9 por defecto z' });
        return body(
          server().patch(`${BASE}/${id}`).set(auth()).send({ isActive: true }),
        );
      },
      SIMULATOR_SET_LIMIT: () => {
        process.env.SIMULATOR_MAX_SETS = '1';
        return body(
          server().post(BASE).set(auth()).send({ name: 'doc 22.9 limite' }),
        );
      },
      SIMULATOR_SET_CARD_LIMIT: async () => {
        const id = (
          await prisma.simulatorSet.findFirstOrThrow({
            where: { nameKey: SET_NAME.toLowerCase() },
          })
        ).id;
        process.env.SIMULATOR_MAX_CARDS_PER_SET = '1';
        return body(
          server()
            .post(`${BASE}/${id}/cards`)
            .set(auth())
            .send({ name: 'x', rarityTier: 'COMMON' }),
        );
      },
      SIMULATOR_CSV_REQUIRED: async () => {
        const id = await mkSet({ name: 'doc 22.9 por defecto v' });
        return body(
          server()
            .post(`${BASE}/${id}/cards/import`)
            .set(auth())
            .field('x', 'y'),
        );
      },
      SIMULATOR_CSV_MULTIPART_INVALID: () =>
        body(
          server()
            .post(`${BASE}/${UUID0}/cards/import`)
            .set(auth())
            .attach('file', csv('name,rarity\n'), 'a.csv')
            .attach('file', csv('name,rarity\n'), 'b.csv'),
        ),
      SIMULATOR_CSV_TOO_LARGE: () =>
        body(importCsv(UUID0, Buffer.alloc(1024 * 1024 + 10, 'a'))),
      SIMULATOR_CSV_INVALID: async () => {
        const id = await mkSet({ name: 'doc 22.9 por defecto w' });
        return body(importCsv(id, csv('name,rarity,foo\nA,common,1\n')));
      },
      SIMULATOR_IMAGE_REQUIRED: () =>
        body(
          server()
            .post('/api/v1/admin/simulator/images')
            .set(auth())
            .field('x', 'y'),
        ),
      SIMULATOR_IMAGE_MULTIPART_INVALID: () =>
        body(
          server()
            .post('/api/v1/admin/simulator/images')
            .set(auth())
            .attach(
              'file',
              readFileSync('test/fixtures/product-image-fixture.png'),
              'a.png',
            )
            .attach(
              'file',
              readFileSync('test/fixtures/product-image-fixture.png'),
              'b.png',
            ),
        ),
      SIMULATOR_IMAGE_TOO_LARGE: () =>
        body(
          server()
            .post('/api/v1/admin/simulator/images')
            .set(auth())
            .attach(
              'file',
              Buffer.concat([
                readFileSync('test/fixtures/product-image-fixture.png'),
                Buffer.alloc(2 * 1024 * 1024),
              ]),
              'big.png',
            ),
        ),
      SIMULATOR_IMAGE_DIMENSIONS: async () => {
        const { pngOf } = await import('./fixtures/landing-images.js');
        return body(
          server()
            .post('/api/v1/admin/simulator/images')
            .set(auth())
            .attach('file', pngOf(5000, 10), 'wide.png'),
        );
      },
      UNSUPPORTED_FILE_TYPE: () =>
        body(
          server()
            .post('/api/v1/admin/simulator/images')
            .set(auth())
            .attach('file', csv('hello'), 'a.txt'),
        ),
      SIMULATOR_CONFIG_INVALID: () =>
        body(
          server()
            .post(BASE)
            .set(auth())
            .send({
              name: 'doc 22.9 cfg',
              template: {
                slots: [{ kind: 'fixed', tier: 'COMMON', count: 4 }],
              },
            }),
        ),
      SIMULATOR_ODDS_INVALID_SUM: () =>
        body(
          server()
            .post(BASE)
            .set(auth())
            .send({
              name: 'doc 22.9 odds',
              template: { slots: [{ kind: 'rare', odds: { RARE: 50 } }] },
            }),
        ),
    };

    it('the catalog table and the trigger list cover exactly the same codes', () => {
      expect([...catalogCodes()].sort()).toEqual(
        [...Object.keys(triggers), ...proven].sort(),
      );
    });

    for (const code of Object.keys(triggers))
      it(`${code} => documented status`, async () => {
        const r = await triggers[code]();
        expect(r.status).toBe(catalogStatus(code));
        expect(r.body.errorCode).toBe(code);
      });

    it('details documented for limits and CSV: SET_LIMIT {max}, CARD_LIMIT {max,current,incoming}, TOO_LARGE {maxBytes}', async () => {
      process.env.SIMULATOR_MAX_SETS = '1';
      const a = await body(
        server().post(BASE).set(auth()).send({ name: 'doc 22.9 limite' }),
      );
      expect(a.body.details).toEqual({ max: 1 });
      const id = (
        await prisma.simulatorSet.findFirstOrThrow({
          where: { nameKey: SET_NAME.toLowerCase() },
        })
      ).id;
      process.env.SIMULATOR_MAX_CARDS_PER_SET = '1';
      const b = await body(
        server()
          .post(`${BASE}/${id}/cards`)
          .set(auth())
          .send({ name: 'x', rarityTier: 'COMMON' }),
      );
      expect(Object.keys(b.body.details ?? {}).sort()).toEqual([
        'current',
        'incoming',
        'max',
      ]);
      const c = await body(importCsv(id, Buffer.alloc(1024 * 1024 + 10, 'a')));
      expect(c.body.details).toEqual({ maxBytes: 1024 * 1024 });
    });
  });

  describe('section 3 / 4.2 clarifications of the document', () => {
    it('PII-looking number/imageUrl/set name => 400 with a STRING message and no errorCode; formulas pass over JSON', async () => {
      const id = await mkSet({ name: 'doc 22.9 por defecto pii' });
      const bad = [
        () =>
          server()
            .post(`${BASE}/${id}/cards`)
            .set(auth())
            .send({ name: 'a', rarityTier: 'COMMON', number: 'a@b.com' }),
        () =>
          server().post(`${BASE}/${id}/cards`).set(auth()).send({
            name: 'a',
            rarityTier: 'COMMON',
            imageUrl: 'https://x.com/a@b.com.png',
          }),
        () => server().post(BASE).set(auth()).send({ name: 'x@y.com' }),
      ];
      for (const r of bad) {
        const res = await r();
        expect(res.status).toBe(400);
        const b = res.body as { message: unknown; errorCode?: string };
        expect(typeof b.message).toBe('string');
        expect(b.message).toMatch(
          /must not contain emails, phone numbers, ID documents, card numbers or secrets/,
        );
        expect(b.errorCode).toBeUndefined();
      }
      await server()
        .post(`${BASE}/${id}/cards`)
        .set(auth())
        .send({ name: '=x', rarityTier: 'COMMON', number: '=1+1' })
        .expect(201);
    });

    it('set name collapses inner spaces; partial odds are valid; login expiresIn is 28800', async () => {
      const r = await server()
        .post(BASE)
        .set(auth())
        .send({
          name: 'doc 22.9  por   defecto  spaces',
          template: { slots: [{ kind: 'rare', odds: { RARE: 100 } }] },
        })
        .expect(201);
      const b = r.body as { name: string; template: unknown };
      expect(b.name).toBe('doc 22.9 por defecto spaces');
      expect(b.template).toEqual({
        slots: [{ kind: 'rare', odds: { RARE: 100 } }],
      });
      const login = await server()
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: USER, password: PASS })
        .expect(200);
      expect((login.body as { expiresIn: number }).expiresIn).toBe(28800);
    });
  });
});
