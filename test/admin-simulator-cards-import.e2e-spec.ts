import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SimulatorPoolCache } from './../src/simulator/pool-cache.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-22-7';
const EMAIL = 'e2e-admin-story-22-7@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-7';
const BASE = '/api/v1/admin/simulator/manual-sets';
const TAG = `e2e227-${Date.now()}`;
const UUID0 = '00000000-0000-4000-8000-000000000000';
const H = 'name,rarity,number,imageUrl,marketPriceUsd';
const tpl = (commons: number) => ({
  slots: [
    { kind: 'fixed', tier: 'COMMON', count: commons },
    { kind: 'rare', odds: { RARE: 100 } },
  ],
});

interface ErrRow {
  row: number;
  field: string;
  code: string;
  message: string;
}
interface Body {
  errorCode?: string;
  message?: string | string[];
  id?: string;
  isActive?: boolean;
  version?: number;
  dryRun?: boolean;
  rows?: number;
  imported?: number;
  details?: {
    errors?: ErrRow[];
    totalErrors?: number;
    truncated?: boolean;
    max?: number;
    current?: number;
    incoming?: number;
    maxBytes?: number;
  };
  cards?: { name: string }[];
}

/** Story 22.7: all-or-nothing CSV import of manual cards (AC1-AC10), real throw-away database. */
describe('Admin manual simulator cards CSV import (e2e, Story 22.7)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let preexisting: string[];
  const savedMax = process.env.SIMULATOR_MAX_CARDS_PER_SET;

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let n = 0;
  const uniq = (s = 's') => `${TAG}-${s}-${++n}`;
  const mkSet = async (body: object = {}): Promise<string> =>
    (
      (
        await server()
          .post(BASE)
          .set(auth())
          .send({ name: uniq(), ...body })
          .expect(201)
      ).body as Body
    ).id as string;
  const url = (setId: string, q = '') => `${BASE}/${setId}/cards/import${q}`;
  const imp = (setId: string, csv: string | Buffer, q = '', field = 'file') =>
    server()
      .post(url(setId, q))
      .set(auth())
      .attach(field, Buffer.isBuffer(csv) ? csv : Buffer.from(csv), {
        filename: 'cartas.csv',
        contentType: 'text/csv',
      });
  const count = (setId: string) =>
    prisma.simulatorCard.count({ where: { setId } });
  const version = async (id: string) =>
    (await prisma.simulatorSet.findUniqueOrThrow({ where: { id } })).version;
  const events = (entityId: string) =>
    prisma.$queryRaw<
      {
        action: string;
        after: Record<string, unknown> | null;
        entityType: string;
      }[]
    >`SELECT "action","after","entityType" FROM "Audit_Events" WHERE "entityId" = ${entityId} ORDER BY "seq"`;
  const rowsCsv = (k: number, prefix = 'c', start = 0) =>
    `${H}\n${Array.from({ length: k }, (_, i) => `${prefix}${start + i},common,${prefix}${start + i},,`).join('\n')}\n`;
  const seed = (setId: string, commons: number) =>
    prisma.simulatorCard.createMany({
      data: [
        ...Array.from({ length: commons }, (_, i) => ({
          setId,
          name: `s${i}`,
          rarityTier: 'COMMON' as const,
          number: `s${i}`,
          numberKey: `s${i}`,
        })),
        {
          setId,
          name: 'r',
          rarityTier: 'RARE' as const,
          number: 'r',
          numberKey: 'r',
        },
      ],
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    preexisting = (
      await prisma.simulatorSet.findMany({ select: { id: true } })
    ).map((s) => s.id);
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
  });

  afterAll(async () => {
    if (savedMax === undefined) delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
    else process.env.SIMULATOR_MAX_CARDS_PER_SET = savedMax;
    await prisma.simulatorSet.deleteMany({
      where: { id: { notIn: preexisting } },
    });
    await app.close();
  });

  describe('AC1: route, dryRun, auth, 404', () => {
    it('401 without a session; 404 unknown set; 400 bad uuid / bad dryRun', async () => {
      await server()
        .post(url(UUID0))
        .attach('file', Buffer.from(H))
        .expect(401);
      const nf = await imp(UUID0, rowsCsv(1)).expect(404);
      expect((nf.body as Body).errorCode).toBe('SIMULATOR_SET_NOT_FOUND');
      await imp('not-a-uuid', rowsCsv(1)).expect(400);
      const s = await mkSet();
      for (const q of [
        '?dryRun=yes',
        '?dryRun=1',
        '?dryRun=TRUE',
        '?dryRun=',
      ]) {
        const r = await imp(s, rowsCsv(1), q);
        expect(r.status).toBe(400);
        expect((r.body as Body).errorCode).toBeUndefined();
      }
      expect(await count(s)).toBe(0);
    });

    it('201 {dryRun:false, rows, imported}; with the template fixture', async () => {
      const s = await mkSet();
      const r = await imp(s, readFileSync('test/fixtures/cards-template.csv'));
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ dryRun: false, rows: 2, imported: 2 });
      const c = await prisma.simulatorCard.findFirstOrThrow({
        where: { setId: s, name: 'Charizard ex' },
      });
      expect(c).toMatchObject({
        rarityTier: 'DOUBLE_RARE',
        number: '001/165',
        imageUrl: 'https://img.example.com/c.png',
      });
      expect(c.marketPriceUsd?.toString()).toBe('12.5');
    });

    it('dryRun=true => 200, writes nothing: no cards, no version bump, no audit, cache untouched', async () => {
      const s = await mkSet();
      const v = await version(s);
      const cache = app.get(SimulatorPoolCache);
      const spy = vi.spyOn(cache, 'clear');
      const before = (await events(s)).length;
      const r = await imp(s, rowsCsv(3), '?dryRun=true');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ dryRun: true, rows: 3, imported: 0 });
      expect(await count(s)).toBe(0);
      expect(await version(s)).toBe(v);
      expect((await events(s)).length).toBe(before);
      expect(spy).not.toHaveBeenCalled();
      const r2 = await imp(s, rowsCsv(3), '?dryRun=false');
      expect(r2.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('AC2: file checks', () => {
    it('missing file / wrong field name => 400 SIMULATOR_CSV_REQUIRED', async () => {
      const s = await mkSet();
      const none = await server().post(url(s)).set(auth()).send({});
      expect(none.status).toBe(400);
      expect((none.body as Body).errorCode).toBe('SIMULATOR_CSV_REQUIRED');
      const other = await imp(s, rowsCsv(1), '', 'csv');
      expect(other.status).toBe(400);
      expect((other.body as Body).errorCode).toBe('SIMULATOR_CSV_REQUIRED');
    });

    it('exactly 1 MB is accepted (as far as size goes), +1 byte => 413', async () => {
      const s = await mkSet();
      const max = 1024 * 1024;
      const pad = (len: number) =>
        Buffer.from(`${H}\nx,common,,,\n${'\n'.repeat(len)}`);
      const head = pad(0).length;
      const ok = await imp(s, pad(max - head));
      expect(ok.status).toBe(201);
      const big = await imp(s, pad(max - head + 1));
      expect(big.status).toBe(413);
      expect(big.body).toMatchObject({
        errorCode: 'SIMULATOR_CSV_TOO_LARGE',
        details: { maxBytes: max },
      });
      expect(await count(s)).toBe(1);
    });

    it('binary (NUL) => 400 UNSUPPORTED_FILE_TYPE', async () => {
      const s = await mkSet();
      const r = await imp(s, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]));
      expect(r.status).toBe(400);
      expect((r.body as Body).errorCode).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('2 files => 400 SIMULATOR_CSV_MULTIPART_INVALID; rows 2000 ok / 2001 => TOO_MANY_ROWS', async () => {
      const s = await mkSet();
      const two = await server()
        .post(url(s))
        .set(auth())
        .attach('file', Buffer.from(rowsCsv(1)), 'a.csv')
        .attach('file', Buffer.from(rowsCsv(1)), 'b.csv');
      expect(two.status).toBe(400);
      expect((two.body as Body).errorCode).toMatch(/^SIMULATOR_CSV_/);
      const ok = await imp(s, rowsCsv(2000));
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ rows: 2000, imported: 2000 });
      const s2 = await mkSet();
      const r = await imp(s2, rowsCsv(2001));
      expect(r.status).toBe(422);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_CSV_INVALID');
      expect((r.body as Body).details?.errors).toEqual([
        expect.objectContaining({
          row: 0,
          field: 'file',
          code: 'TOO_MANY_ROWS',
        }),
      ]);
      expect(await count(s2)).toBe(0);
    });

    it.each([
      ['empty', ''],
      ['header only', H],
      ['header + newline', `${H}\r\n`],
    ])('%s => 422 EMPTY', async (_l, csv) => {
      const s = await mkSet();
      const r = await imp(s, csv);
      expect(r.status).toBe(422);
      expect((r.body as Body).details?.errors?.[0]).toMatchObject({
        row: 0,
        code: 'EMPTY',
      });
    });
  });

  describe('AC3: encoding and dialects', () => {
    it('latin-1 => ENCODING; BOM + CRLF + `;` + quotes + multi-line OK', async () => {
      const s = await mkSet();
      const bad = await imp(s, Buffer.from(`${H}\nPeña,common,,,\n`, 'latin1'));
      expect(bad.status).toBe(422);
      expect((bad.body as Body).details?.errors?.[0]).toMatchObject({
        row: 0,
        field: 'file',
        code: 'ENCODING',
      });
      const csv =
        '﻿name;rarity;number\r\n"Charizard ex; ""Holo, Rev""";Double Rare;1\r\n"Multi\nline";Common;2\r\n';
      const ok = await imp(s, csv);
      expect(ok.status).toBe(201);
      const names = (
        await prisma.simulatorCard.findMany({ where: { setId: s } })
      ).map((c) => c.name);
      expect(names.sort()).toEqual([
        'Charizard ex; "Holo, Rev"',
        'Multi\nline',
      ]);
    });

    it('weird inputs never 500: quotes, exponents, formulas, short/long rows, unicode, blank cells', async () => {
      const s = await mkSet();
      const inputs = [
        `${H}\n"unterminated,common,,,\n`,
        `${H}\n"a"b,common,,,\n`,
        `${H}\nx,common,,,1e999\n`,
        `${H}\nx,common,,,1e-7\n`,
        `${H}\n=cmd|' /C calc'!A0,common,,,\n`,
        `${H}\nx,common\ny,common,1,,,,,,\n`,
        `${H}\n,,,,\n,,,,\n`,
        `${H}\n日本語 ✨,común,№1,,٣\n`,
        `\uFEFF\uFEFF${H}\nx,common,,,\n`,
        `${H}\n${'x'.repeat(5000)},common,,,\n`,
        `\n\n\n`,
        `;;;;\n;;;;\n`,
        `"""\n`,
      ];
      for (const csv of inputs) {
        for (const q of ['', '?dryRun=true']) {
          const r = await imp(s, csv, q);
          expect([201, 200, 400, 422]).toContain(r.status);
          if (r.status === 422)
            expect((r.body as Body).errorCode).toBe('SIMULATOR_CSV_INVALID');
        }
      }
    });
  });

  describe('AC4/AC5/AC6: header, per-row rules, report, all-or-nothing', () => {
    it('header errors are reported on row 1', async () => {
      const s = await mkSet();
      const r = await imp(s, 'rarity,foo,rarity\ncommon,1,common\n');
      const codes = (r.body as Body).details?.errors?.map(
        (e) => `${e.row}:${e.field}:${e.code}`,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          '1:foo:UNKNOWN_COLUMN',
          '1:rarity:DUPLICATE_COLUMN',
          '1:name:MISSING_COLUMN',
        ]),
      );
    });

    it('all errors in one pass; nothing written; no audit; dryRun gives the same 422', async () => {
      const s = await mkSet();
      await seed(s, 2);
      const before = await count(s);
      const v = await version(s);
      const ev = (await events(s)).length;
      const csv = [
        H,
        'ok,common,n1,,',
        ',common,,,',
        'x,promo,,,',
        'x,common,,http://a.com/x.png,',
        'x,common,,,1,5',
        'x,common,,,abc',
        'dup,common,n1,,',
        'x,common,s0,,',
        'short',
      ].join('\n');
      const real = await imp(s, csv);
      const dry = await imp(s, csv, '?dryRun=true');
      expect(real.status).toBe(422);
      expect(dry.status).toBe(422);
      expect(dry.body).toEqual(real.body);
      const b = real.body as Body;
      expect(b.errorCode).toBe('SIMULATOR_CSV_INVALID');
      expect(
        b.details?.errors?.map((e) => `${e.row}:${e.field}:${e.code}`),
      ).toEqual([
        '3:name:REQUIRED',
        '4:rarity:INVALID_RARITY',
        '5:imageUrl:INVALID_URL',
        '6:row:COLUMN_COUNT',
        '7:marketPriceUsd:INVALID_PRICE',
        '8:number:DUPLICATE_NUMBER',
        '9:number:DUPLICATE_NUMBER',
        '10:row:COLUMN_COUNT',
      ]);
      expect(await count(s)).toBe(before);
      expect(await version(s)).toBe(v);
      expect((await events(s)).length).toBe(ev);
    });

    it('150 invalid rows => 100 reported, totalErrors 150, truncated', async () => {
      const s = await mkSet();
      const csv = `${H}\n${Array.from({ length: 150 }, () => ',common,,,').join('\n')}\n`;
      const r = await imp(s, csv);
      const d = (r.body as Body).details!;
      expect(d.errors).toHaveLength(100);
      expect(d.totalErrors).toBe(150);
      expect(d.truncated).toBe(true);
      expect(await count(s)).toBe(0);
    });

    it('rarity spellings map to tiers', async () => {
      const s = await mkSet();
      const csv = `${H}\na,DOUBLE_RARE,1,,\nb,double rare,2,,\nc,double-rare,3,,\nd,Illustration Rare,4,,\ne,Rare Holo,5,,\n`;
      expect((await imp(s, csv)).status).toBe(201);
      const tiers = (
        await prisma.simulatorCard.findMany({
          where: { setId: s },
          orderBy: { number: 'asc' },
        })
      ).map((c) => c.rarityTier);
      expect(tiers).toEqual([
        'DOUBLE_RARE',
        'DOUBLE_RARE',
        'DOUBLE_RARE',
        'ILLUSTRATION_RARE',
        'RARE',
      ]);
    });

    it('formulas and PII-looking numbers/URLs are rejected, not stored', async () => {
      const s = await mkSet();
      const r = await imp(
        s,
        `${H}\n=cmd|' /C calc'!A0,common,,,\nok,common,user@example.com,,\n`,
      );
      expect(r.status).toBe(422);
      expect((r.body as Body).details?.errors?.map((e) => e.code)).toEqual([
        'FORMULA',
        'UNSAFE_TEXT',
      ]);
      expect(await count(s)).toBe(0);
    });
  });

  describe('AC7: lock, cap, concurrency', () => {
    it('cap: details {max,current,incoming}; nothing written', async () => {
      process.env.SIMULATOR_MAX_CARDS_PER_SET = '10';
      try {
        const s = await mkSet();
        await seed(s, 5); // 6 cards
        const r = await imp(s, rowsCsv(5));
        expect(r.status).toBe(422);
        expect(r.body).toMatchObject({
          errorCode: 'SIMULATOR_SET_CARD_LIMIT',
          details: { max: 10, current: 6, incoming: 5 },
        });
        expect((await imp(s, rowsCsv(5), '?dryRun=true')).status).toBe(422);
        expect(await count(s)).toBe(6);
        expect((await imp(s, rowsCsv(4))).status).toBe(201);
        expect(await count(s)).toBe(10);
      } finally {
        delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
      }
    });

    it('two simultaneous imports that together exceed the cap: exactly one proceeds', async () => {
      process.env.SIMULATOR_MAX_CARDS_PER_SET = '10';
      try {
        const s = await mkSet();
        const rs = await Promise.all([
          imp(s, rowsCsv(6, 'a')),
          imp(s, rowsCsv(6, 'b')),
        ]);
        expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
        expect(await count(s)).toBe(6);
      } finally {
        delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
      }
    });

    it('22.10: numbers clash ignoring case, in the file and against the set; kept as written', async () => {
      const s = await mkSet();
      await seed(s, 1); // number 's0', numberKey 's0'
      const bad = await imp(
        s,
        `${H}\na,common,A1,,\nb,common,a1,,\nc,common,S0,,\nd,common,TG12,,\n`,
      );
      expect(bad.status).toBe(422);
      expect(
        (bad.body as Body).details?.errors?.map((e) => `${e.row}:${e.code}`),
      ).toEqual(['3:DUPLICATE_NUMBER', '4:DUPLICATE_NUMBER']);
      const dry = await imp(
        s,
        `${H}\na,common,A1,,\nb,common,a1,,\n`,
        '?dryRun=true',
      );
      expect(dry.status).toBe(422);
      const ok = await imp(s, `${H}\na,common,Tg12,,\nb,common,A1,,\n`);
      expect(ok.status).toBe(201);
      const rows = await prisma.simulatorCard.findMany({
        where: { setId: s, name: { in: ['a', 'b'] } },
        orderBy: { name: 'asc' },
      });
      expect(rows.map((r) => [r.number, r.numberKey])).toEqual([
        ['Tg12', 'tg12'],
        ['A1', 'a1'],
      ]);
      const again = await imp(s, `${H}\nz,common,tG12,,\n`);
      expect(again.status).toBe(422);
    });

    it('22.10: concurrent imports A1 vs a1: one wins, the other 422 DUPLICATE_NUMBER, never 500', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await mkSet();
        const rs = await Promise.all(
          ['A1', 'a1'].map((n) => imp(s, `${H}\nx,common,${n},,\n`)),
        );
        expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
        expect(await count(s)).toBe(1);
      }
    });

    it('two simultaneous imports with clashing numbers: one wins, the other 422 DUPLICATE_NUMBER, never 500', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await mkSet();
        const rs = await Promise.all(
          Array.from({ length: 4 }, () => imp(s, rowsCsv(30, 'same'))),
        );
        expect(rs.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
        for (const r of rs.filter((x) => x.status === 422))
          expect(
            (r.body as Body).details?.errors?.every(
              (e) => e.code === 'DUPLICATE_NUMBER',
            ),
          ).toBe(true);
        expect(await count(s)).toBe(30);
      }
    });

    it('import || delete of cards || activation: set never active without sufficiency', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await mkSet({ template: tpl(2) });
        await seed(s, 2);
        const [a] = await prisma.simulatorCard.findMany({
          where: { setId: s, rarityTier: 'COMMON' },
          select: { id: true },
        });
        const rs = await Promise.all([
          imp(s, rowsCsv(20)),
          server().delete(`${BASE}/${s}/cards/${a.id}`).set(auth()),
          server().patch(`${BASE}/${s}`).set(auth()).send({ isActive: true }),
          imp(s, rowsCsv(20, 'z')),
        ]);
        for (const r of rs) expect(r.status).toBeLessThan(500);
        const st = await prisma.simulatorSet.findUniqueOrThrow({
          where: { id: s },
        });
        if (st.isActive) {
          const commons = await prisma.simulatorCard.count({
            where: { setId: s, rarityTier: 'COMMON' },
          });
          expect(commons).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });

  describe('AC8/AC9: active sets, audit', () => {
    it('importing into an ACTIVE set keeps it ready and the cards reach POST /simulator/packs', async () => {
      const s = await mkSet({ template: tpl(1) });
      await seed(s, 1);
      await server()
        .patch(`${BASE}/${s}`)
        .set(auth())
        .send({ isActive: true })
        .expect(200);
      const r = await imp(s, `${H}\nNEWRARE-${TAG},rare,NR1,,9.99\n`);
      expect(r.status).toBe(201);
      const st = (await server().get(`${BASE}/${s}`).set(auth()).expect(200))
        .body as Body & { readiness?: { ready: boolean } };
      expect(st.isActive).toBe(true);
      expect(st.readiness?.ready).toBe(true);
      const seen = new Set<string>();
      for (let i = 0; i < 60 && !seen.has(`NEWRARE-${TAG}`); i++) {
        const p = await server()
          .post('/api/v1/simulator/packs')
          .set('X-Forwarded-For', `203.0.113.${(i % 250) + 1}`)
          .send({ setId: s })
          .expect(200);
        for (const c of (p.body as Body).cards ?? []) seen.add(c.name);
      }
      expect(seen.has(`NEWRARE-${TAG}`)).toBe(true);
    });

    it('existing cards are untouched (no upsert); a clash with them fails the whole file', async () => {
      const s = await mkSet();
      await seed(s, 1);
      const before = await prisma.simulatorCard.findMany({
        where: { setId: s },
        orderBy: { number: 'asc' },
      });
      const r = await imp(s, `${H}\nfresh,common,f1,,\nclash,rare,s0,,5\n`);
      expect(r.status).toBe(422);
      const after = await prisma.simulatorCard.findMany({
        where: { setId: s },
        orderBy: { number: 'asc' },
      });
      expect(after).toEqual(before);
    });

    it('one SIMULATOR_CARDS_IMPORTED event {setId, imported}, no names, none for dryRun/errors', async () => {
      const s = await mkSet();
      await imp(s, rowsCsv(3), '?dryRun=true').expect(200);
      await imp(s, `${H}\n,common,,,\n`).expect(422);
      const secret = `Cedula V-12345678 ${TAG}`;
      const csv = `${H}\n"${secret}",common,a1,,\nb,common,a2,,\nc,rare,a3,,\n`;
      await imp(s, csv).expect(201);
      const ev = (await events(s)).filter(
        (e) => e.action === 'SIMULATOR_CARDS_IMPORTED',
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].entityType).toBe('SimulatorSet');
      expect(ev[0].after).toEqual({ setId: s, imported: 3 });
      expect(JSON.stringify(ev[0])).not.toContain('12345678');
      expect(
        (await events(s)).filter((e) => e.action === 'SIMULATOR_CARD_CREATED'),
      ).toHaveLength(0);
    });
  });

  describe('AC10: no SSRF', () => {
    it('https imageUrl is stored but never fetched', async () => {
      const s = await mkSet();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const reqSpy = vi.spyOn(http, 'request');
      const getSpy = vi.spyOn(https, 'request');
      const r = await imp(
        s,
        `${H}\nx,common,1,https://169.254.169.254/latest/meta-data/x.png,\n`,
      );
      expect(r.status).toBe(201);
      // supertest itself talks http to the app (loopback): only assert nothing targeted the image host
      const hosts = [...reqSpy.mock.calls, ...getSpy.mock.calls].map((c) =>
        JSON.stringify(c[0]),
      );
      expect(hosts.some((h) => h.includes('169.254'))).toBe(false);
      expect(
        fetchSpy.mock.calls.some((c) =>
          JSON.stringify(c[0]).includes('169.254'),
        ),
      ).toBe(false);
      fetchSpy.mockRestore();
      reqSpy.mockRestore();
      getSpy.mockRestore();
    });
  });
});
