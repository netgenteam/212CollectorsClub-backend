/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- supertest bodies and pg rows are untyped JSON; the audit callbacks must return a Promise by signature */
import { randomUUID } from 'node:crypto';
import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { MailerService } from './../src/common/mailer/mailer.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  AuditService,
  AUDIT_CHAIN_LOCK_KEY,
} from './../src/audit/audit.service.js';
import { AUDIT_VERIFY_LOCK_KEY } from './../src/audit/audit-verify.service.js';
import { AuditVerifyCron } from './../src/audit/audit-verify.cron.js';
import { GENESIS_HASH } from './../src/audit/canonical-json.js';
import {
  adminDatabaseUrl,
  createAuditSandbox,
} from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';
import { mintAdminToken } from './helpers/admin-session.js';

/**
 * Story 20.1 (AC7, AC9, AC10): the whole app, with its connection pointed at a
 * SANDBOX schema (search_path), so verify / AUDIT_VERIFIED / the seeded events
 * never reach the real, immutable `Audit_Events`. The admin user is created in
 * the real DB like every other e2e and removed afterwards.
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-audit-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PASS = 'correct-horse-battery-staple-20-1';
const BASE = '/api/v1/admin/audit';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Ctx {
  app: NestExpressApplication;
  sb: AuditSandbox;
  token: string;
  adminId: string;
  prisma: PrismaService;
  savedUrl: string | undefined;
}

async function boot(opts: { noTriggers?: boolean }): Promise<Ctx> {
  const sb = await createAuditSandbox(opts);
  const savedUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = sb.url;
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', 1);
  applyRequestContext(app);
  app.use(
    cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createGlobalValidationPipe());
  await app.init();
  const prisma = app.get(PrismaService);
  const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
  const admin = await prisma.adminUser.upsert({
    where: { username: USER },
    create: { username: USER, email: EMAIL, passwordHash },
    update: { email: EMAIL, passwordHash },
  });
  // Story 20.5: not through the login endpoint (it audits LOGIN_ADMIN_OK; this suite starts from an
  // EMPTY chain on purpose).
  const token = await mintAdminToken(app, admin.id);
  return {
    app,
    sb,
    prisma,
    savedUrl,
    adminId: admin.id,
    token,
  };
}

async function shutdown(c: Ctx): Promise<void> {
  await c.prisma.adminUser.deleteMany({ where: { username: USER } });
  await c.app.close();
  if (c.savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = c.savedUrl;
  await c.sb.drop();
}

const rawClient = async (): Promise<pg.Client> => {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
};

describe('Admin audit API (e2e, Story 20.1) on a sandbox schema', () => {
  let c: Ctx;
  const server = () => request(c.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${c.token}` });
  const actorA = randomUUID();
  const reqIdA = randomUUID();

  beforeAll(async () => {
    c = await boot({});
  }, 60_000);
  afterAll(async () => {
    await shutdown(c);
  });

  it('401 without token on every route; X-Request-Id is still returned and the client one ignored (AC7, AC9)', async () => {
    for (const [m, p] of [
      ['get', '/events'],
      ['get', '/events/1'],
      ['get', '/head'],
      ['post', '/verify'],
      ['get', '/verifications'],
    ] as const) {
      const res = await server()
        [m](`${BASE}${p}`)
        .set('X-Request-Id', 'forged')
        .expect(401);
      expect(res.headers['x-request-id']).toMatch(UUID_V4);
      expect(res.headers['x-request-id']).not.toBe('forged');
    }
  });

  it('an empty chain: head is seq 0 with the genesis hash; verify is OK with 0 rows; events is empty', async () => {
    const head = await server().get(`${BASE}/head`).set(auth()).expect(200);
    expect(head.body).toEqual({
      seq: 0,
      hash: GENESIS_HASH,
      count: 0,
      at: null,
      anchorEmailConfigured: expect.any(Boolean),
    });
    const ev = await server().get(`${BASE}/events`).set(auth()).expect(200);
    expect(ev.body).toEqual({ items: [], nextCursor: null });
    const v = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({})
      .expect(200);
    expect(v.body).toMatchObject({ ok: true, rows: 0, done: true });
  });

  it('head and verifications tell the screen whether the external anchor (AUDIT_ANCHOR_EMAIL) is configured', async () => {
    const saved = process.env.AUDIT_ANCHOR_EMAIL;
    try {
      delete process.env.AUDIT_ANCHOR_EMAIL;
      for (const path of ['/head', '/verifications']) {
        const res = await server()
          .get(`${BASE}${path}`)
          .set(auth())
          .expect(200);
        expect(
          (res.body as { anchorEmailConfigured: boolean })
            .anchorEmailConfigured,
        ).toBe(false);
      }
      process.env.AUDIT_ANCHOR_EMAIL = 'anchor@example.com';
      for (const path of ['/head', '/verifications']) {
        const res = await server()
          .get(`${BASE}${path}`)
          .set(auth())
          .expect(200);
        expect(
          (res.body as { anchorEmailConfigured: boolean })
            .anchorEmailConfigured,
        ).toBe(true);
      }
    } finally {
      if (saved === undefined) delete process.env.AUDIT_ANCHOR_EMAIL;
      else process.env.AUDIT_ANCHOR_EMAIL = saved;
    }
  });

  it('seed 120 events through AuditService (as 20.5 will)', async () => {
    const audit = c.app.get(AuditService);
    for (let i = 0; i < 120; i += 4) {
      await audit.transaction(async (_tx, a) => {
        for (let k = i; k < i + 4; k++) {
          a.add({
            actorType: k % 2 === 0 ? 'ADMIN' : 'SYSTEM',
            actorId: k % 2 === 0 ? actorA : null,
            action:
              k % 3 === 0 ? 'ORDER_STATUS_CHANGED' : 'PRODUCT_PRICE_CHANGED',
            entityType: k % 3 === 0 ? 'ORDER' : 'PRODUCT',
            entityId: `e-${k}`,
            before: { n: k },
            after: { n: k + 1, price: '10.50' },
            reason: k === 7 ? 'manual' : null,
            requestId: k === 7 ? reqIdA : undefined,
            ip: '198.51.100.4',
          });
        }
      });
    }
    const head = await server().get(`${BASE}/head`).set(auth()).expect(200);
    // 1 AUDIT_VERIFIED from the empty verify above + 120
    expect(head.body).toMatchObject({ seq: 121, count: 121 });
    expect(head.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(head.body.at).toMatch(/T.*Z$/);
  });

  it('events: newest first, 50 per page, cursor walks every row exactly once', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await server()
        .get(`${BASE}/events${cursor ? `?cursor=${cursor}` : ''}`)
        .set(auth())
        .expect(200);
      const body = res.body as {
        items: { seq: number; hash: string; prevHash: string }[];
        nextCursor: string | null;
      };
      expect(body.items.length).toBeLessThanOrEqual(50);
      seen.push(...body.items.map((i) => i.seq));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(121);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(121);
  });

  it('events: filters (action, actorId, entityType, entityId, requestId, from/to) combine', async () => {
    const q = async (qs: string) =>
      (await server().get(`${BASE}/events?${qs}`).set(auth()).expect(200))
        .body as {
        items: {
          action: string;
          actorId: string | null;
          entityType: string;
          entityId: string;
          requestId: string | null;
          seq: number;
        }[];
        nextCursor: string | null;
      };
    const a = await q('action=ORDER_STATUS_CHANGED');
    expect(a.items.length).toBe(40);
    expect(a.items.every((i) => i.action === 'ORDER_STATUS_CHANGED')).toBe(
      true,
    );
    const b = await q(`actorId=${actorA}&entityType=PRODUCT`);
    expect(
      b.items.every((i) => i.actorId === actorA && i.entityType === 'PRODUCT'),
    ).toBe(true);
    expect(b.items.length).toBeGreaterThan(0);
    const e = await q('entityId=e-7');
    expect(e.items.map((i) => i.entityId)).toEqual(['e-7']);
    const r = await q(`requestId=${reqIdA}`);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].requestId).toBe(reqIdA);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await q(`from=${today}&to=${today}&action=PRODUCT_PRICE_CHANGED`)).items
        .length,
    ).toBe(50);
    expect((await q('to=2020-01-01')).items).toHaveLength(0);
    expect((await q('from=2999-01-01')).items).toHaveLength(0);
  });

  it('events: 400 AUDIT_FILTER_INVALID for bad filters / cursor / repeated params', async () => {
    for (const qs of [
      'cursor=abc',
      'cursor=0',
      'cursor=-1',
      'cursor=1.5',
      'from=yesterday',
      'to=2026-13-40',
      'from=2026-02-01&to=2026-01-01',
      'action=lower',
      'actorId=nope',
      'requestId=1',
      'entityType=a%20b',
      'action=A&action=B',
    ]) {
      const res = await server()
        .get(`${BASE}/events?${qs}`)
        .set(auth())
        .expect(400);
      expect(res.body).toMatchObject({ errorCode: 'AUDIT_FILTER_INVALID' });
    }
  });

  it('events: QA round 2 (AC9) values that used to be a 500 or a shifted date are 400 AUDIT_FILTER_INVALID', async () => {
    for (const qs of [
      'entityId=%00',
      'entityId=a%00b',
      'entityId=' + 'x'.repeat(129),
      'from=0000-01-01',
      'from=0001-01-01',
      'to=0000-12-31',
      'from=1999-12-31',
      'from=3000-01-01',
      'from=9999-12-31',
      'from=2026-02-30',
      'from=2026-02-29',
      'from=2026-04-31',
      'to=2026-06-31',
      'from=2026-02-30T10:00:00Z',
      'from=2026-11-03T25:00:00Z',
      'from=2026-11-03T24:00:00Z',
      'from=2026-11-03T10:00:00%2B24:00',
      'from=2026-11-03T10:00:00',
      'from=%00',
      'to=%00',
      'actorId=%00',
      'requestId=%00',
      'action=%00',
      'entityType=%00',
      'cursor=%00',
      'cursor=9007199254740993',
      'cursor=9999999999999999',
      'from=2026-11-01&from=2026-11-02',
      'entityId=',
    ]) {
      const res = await server().get(`${BASE}/events?${qs}`).set(auth());
      expect(res.status, qs).toBe(400);
      expect(res.body, qs).toMatchObject({ errorCode: 'AUDIT_FILTER_INVALID' });
    }
    for (const bad of ['%00', '9007199254740993', '9999999999999999', '1e3']) {
      expect(
        (await server().get(`${BASE}/events/${bad}`).set(auth())).status,
        bad,
      ).toBe(400);
    }
    // valid edge cases still work
    for (const qs of [
      'from=2028-02-29',
      'from=2026-11-03T10:00:00%2B02:00',
      'from=2000-01-01&to=2999-12-31',
      'entityId=' + 'x'.repeat(128),
      'entityId=%F0%9F%98%80',
    ]) {
      await server().get(`${BASE}/events?${qs}`).set(auth()).expect(200);
    }
  });

  it('events: fuzzing every filter with hostile values never gives a 5xx (only 200 or 400)', async () => {
    const hostile = [
      '',
      '%00',
      '%0A',
      '%0D%0A',
      '%27',
      '%22%3B--',
      '%5C',
      '%25',
      '%F0%9F%98%80',
      '%ED%A0%80',
      '%C0%AF',
      '%FF',
      '%E2%80%AE',
      '0',
      '-1',
      '1e309',
      'NaN',
      'null',
      'undefined',
      '[]',
      '%7B%7D',
      '9'.repeat(40),
      'a'.repeat(300),
      '0000-00-00',
      '2026-13-01',
      '2026-00-00T00:00:00Z',
      '+002026-01-01T00:00:00Z',
      '2026-01-01T00:00:00+99:99',
      '%20',
      '1.5',
      '0x10',
      '0b1',
      '١٢٣',
      '2026-01-01T00:00:00.9999Z',
      '9999-12-31T23:59:59Z',
      '10000-01-01',
    ];
    const keys = [
      'from',
      'to',
      'action',
      'actorId',
      'entityType',
      'entityId',
      'requestId',
      'cursor',
    ];
    for (const k of keys) {
      for (const h of hostile) {
        const res = await server().get(`${BASE}/events?${k}=${h}`).set(auth());
        expect([200, 400], `${k}=${h} -> ${res.status}`).toContain(res.status);
      }
    }
    for (const h of hostile) {
      const res = await server().get(`${BASE}/events/${h}`).set(auth());
      expect([200, 400, 404], `/events/${h} -> ${res.status}`).toContain(
        res.status,
      );
    }
  });

  it('GET /events/:seq: the row with its hashes and the entity link; 404 and 400', async () => {
    const res = await server().get(`${BASE}/events/8`).set(auth()).expect(200);
    expect(res.body).toMatchObject({
      seq: 8,
      entityLink: expect.stringMatching(/^\/admin\/(orders|products)\//),
    });
    expect(res.body.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
    const prev = await server().get(`${BASE}/events/7`).set(auth()).expect(200);
    expect(res.body.prevHash).toBe(prev.body.hash);
    expect(
      (await server().get(`${BASE}/events/999999`).set(auth()).expect(404))
        .body,
    ).toMatchObject({ errorCode: 'AUDIT_EVENT_NOT_FOUND' });
    for (const bad of ['abc', '0', '-3', '1.5']) {
      await server().get(`${BASE}/events/${bad}`).set(auth()).expect(400);
    }
  });

  it('verify: OK; writes Audit_Verifications and AUDIT_VERIFIED with the admin, the request id and the ip (AC9)', async () => {
    const res = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ mode: 'full' })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      mode: 'full',
      checkedFrom: 1,
      checkedTo: 121,
      rows: 121,
      done: true,
    });
    expect(res.body.verificationId).toMatch(/^[0-9a-f-]{36}$/);
    const rid = res.headers['x-request-id'];
    expect(rid).toMatch(UUID_V4);
    const list = await server()
      .get(`${BASE}/events?action=AUDIT_VERIFIED`)
      .set(auth())
      .expect(200);
    const ev = (
      list.body as {
        items: {
          actorType: string;
          actorId: string;
          requestId: string;
          ip: string;
          entityId: string;
          after: Record<string, unknown>;
        }[];
      }
    ).items[0];
    expect(ev).toMatchObject({
      actorType: 'ADMIN',
      actorId: c.adminId,
      requestId: rid,
      entityId: res.body.verificationId,
    });
    expect(ev.ip).toMatch(/127\.0\.0\.1$/);
    expect(ev.after).toMatchObject({ result: 'OK', mode: 'full', rows: 121 });

    const vs = await server()
      .get(`${BASE}/verifications`)
      .set(auth())
      .expect(200);
    expect(vs.body.chainBroken).toBe(false);
    expect(vs.body.items[0]).toMatchObject({
      id: res.body.verificationId,
      result: 'OK',
      mode: 'full',
      toSeq: 121,
      rows: 121,
    });

    // incremental right after: starts at the last OK row and sees the AUDIT_VERIFIED rows written since
    const inc = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({})
      .expect(200);
    expect(inc.body).toMatchObject({
      ok: true,
      mode: 'incremental',
      checkedFrom: 121,
      done: true,
    });
    expect(inc.body.rows).toBeGreaterThanOrEqual(2);
  });

  it('verify: resumable with limit/fromSeq, 400 for invalid bodies, 400 when fromSeq is beyond the chain', async () => {
    let from: number | undefined;
    let total = 0;
    let calls = 0;
    for (;;) {
      const res = await server()
        .post(`${BASE}/verify`)
        .set(auth())
        .send({ mode: 'full', limit: 60, ...(from ? { fromSeq: from } : {}) })
        .expect(200);
      calls += 1;
      expect(res.body.ok).toBe(true);
      total += res.body.rows as number;
      if (res.body.done) break;
      from = res.body.nextFromSeq as number;
      expect(from).toBe(res.body.checkedTo + 1);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    const head = (await server().get(`${BASE}/head`).set(auth()).expect(200))
      .body as { seq: number };
    // The AUDIT_VERIFIED rows written by earlier slices also join the chain; at least all rows at the start were covered.
    expect(total).toBeGreaterThanOrEqual(121);
    expect(total).toBeLessThanOrEqual(head.seq);
    for (const bad of [
      { limit: 200_001 },
      { limit: 0 },
      { limit: 1.5 },
      { mode: 'fast' },
      { fromSeq: 0 },
      { fromSeq: 'x' },
      { extra: 1 },
      [],
    ]) {
      await server()
        .post(`${BASE}/verify`)
        .set(auth())
        .send(bad as object)
        .expect((r) => {
          if (r.status !== 400)
            throw new Error(`body ${JSON.stringify(bad)} => ${r.status}`);
        });
    }
    const out = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ fromSeq: head.seq + 5 })
      .expect(400);
    expect(out.body).toMatchObject({
      errorCode: 'AUDIT_FROM_SEQ_OUT_OF_RANGE',
    });
  });

  it('verify: a second one while another runs is a clean 409 AUDIT_VERIFY_IN_PROGRESS', async () => {
    const holder = await rawClient();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(${AUDIT_VERIFY_LOCK_KEY})`,
      );
      const res = await server()
        .post(`${BASE}/verify`)
        .set(auth())
        .send({})
        .expect(409);
      expect(res.body).toMatchObject({ errorCode: 'AUDIT_VERIFY_IN_PROGRESS' });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    await server().post(`${BASE}/verify`).set(auth()).send({}).expect(200);
  });

  it('verify under a held chain-head lock: 503 AUDIT_UNAVAILABLE (its AUDIT_VERIFIED cannot be written), never 500 (AC5)', async () => {
    const holder = await rawClient();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`,
      );
      const res = await server()
        .post(`${BASE}/verify`)
        .set(auth())
        .send({})
        .expect(503);
      expect(res.body).toMatchObject({
        errorCode: 'AUDIT_UNAVAILABLE',
        details: { reason: 'LOCK_TIMEOUT' },
      });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  }, 30_000);

  it('there is NO route to change or delete events (AC9)', async () => {
    for (const m of ['put', 'patch', 'delete', 'post'] as const) {
      for (const p of ['/events', '/events/1', '/head', '/verifications/1']) {
        const res = await server()[m](`${BASE}${p}`).set(auth()).send({});
        expect([404, 405]).toContain(res.status);
      }
    }
    const n = await c.sb.exec(
      `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "seq" = 1`,
    );
    expect(n[0].n).toBe(1);
  });

  it('Swagger documents the five routes with their errorCodes', () => {
    const doc = SwaggerModule.createDocument(
      c.app,
      new DocumentBuilder().setTitle('t').setVersion('1').build(),
    );
    const paths = Object.keys(doc.paths).filter((p) =>
      p.includes('/admin/audit'),
    );
    expect(paths.sort()).toEqual([
      '/api/v1/admin/audit/events',
      '/api/v1/admin/audit/events/{seq}',
      '/api/v1/admin/audit/head',
      '/api/v1/admin/audit/verifications',
      '/api/v1/admin/audit/verify',
    ]);
    const text = JSON.stringify(paths.map((p) => doc.paths[p]));
    for (const code of [
      'AUDIT_FILTER_INVALID',
      'AUDIT_EVENT_NOT_FOUND',
      'AUDIT_VERIFY_IN_PROGRESS',
      'AUDIT_UNAVAILABLE',
      'AUDIT_FROM_SEQ_OUT_OF_RANGE',
      'INVALID_ADMIN_TOKEN',
    ]) {
      expect(text).toContain(code);
    }
  });
});

describe('Weekly verification job (e2e, Story 20.1 AC10) on a sandbox without triggers', () => {
  let c: Ctx;
  const server = () => request(c.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${c.token}` });
  let cron: AuditVerifyCron;
  let sendMail: ReturnType<typeof vi.spyOn>;
  const savedEmail = process.env.AUDIT_ANCHOR_EMAIL;

  beforeAll(async () => {
    c = await boot({ noTriggers: true });
    cron = c.app.get(AuditVerifyCron);
    sendMail = vi
      .spyOn(c.app.get(MailerService), 'sendMail')
      .mockResolvedValue(undefined);
    const audit = c.app.get(AuditService);
    for (let i = 0; i < 15; i += 5) {
      await audit.transaction(async (_tx, a) => {
        for (let k = i; k < i + 5; k++) {
          a.add({
            actorType: 'SYSTEM',
            action: 'RETENTION_PURGE_RUN',
            entityType: 'RUN',
            entityId: `r-${k}`,
            after: { k },
          });
        }
      });
    }
  }, 60_000);
  afterAll(async () => {
    if (savedEmail === undefined) delete process.env.AUDIT_ANCHOR_EMAIL;
    else process.env.AUDIT_ANCHOR_EMAIL = savedEmail;
    vi.restoreAllMocks();
    await shutdown(c);
  });

  it('is off under NODE_ENV=test unless AUDIT_VERIFY_ENABLED=true (so no e2e run fires it by itself)', () => {
    expect(cron.isEnabled()).toBe(false);
  });

  it('OK run without AUDIT_ANCHOR_EMAIL: no mail; with it: head (seq + hash) is mailed', async () => {
    delete process.env.AUDIT_ANCHOR_EMAIL;
    const r1 = await cron.runScheduled();
    expect(r1).toMatchObject({ status: 'OK', anchorEmailSent: false });
    expect(sendMail).not.toHaveBeenCalled();

    process.env.AUDIT_ANCHOR_EMAIL = 'anchor@212collectorsclub.test';
    const r2 = await cron.runScheduled();
    expect(r2).toMatchObject({ status: 'OK', anchorEmailSent: true });
    const head = (await server().get(`${BASE}/head`).set(auth()).expect(200))
      .body as { seq: number; hash: string };
    const mail = sendMail.mock.calls[0][0] as {
      to: string;
      text: string;
      subject: string;
    };
    expect(mail.to).toBe('anchor@212collectorsclub.test');
    expect(mail.text).toContain(`seq: ${head.seq}`); // the head when the mail was composed (before the next AUDIT_VERIFIED)
    expect(mail.text).toMatch(/hash: [0-9a-f]{64}/);
    const vs = await server()
      .get(`${BASE}/verifications`)
      .set(auth())
      .expect(200);
    expect(
      vs.body.items.some((i: { source: string }) => i.source === 'CRON'),
    ).toBe(true);
  });

  it('a mail failure never breaks the job', async () => {
    process.env.AUDIT_ANCHOR_EMAIL = 'anchor@212collectorsclub.test';
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const r = await cron.runScheduled();
    expect(r).toMatchObject({ status: 'OK', anchorEmailSent: false });
  });

  it('a manipulated chain: BROKEN, logger.error, the flag is visible in GET /verifications and stays until a later verification is OK', async () => {
    const err = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    // Tamper (the sandbox has no triggers): alter row 9.
    const original = await c.sb.exec(
      `SELECT "after"::text AS "a" FROM "Audit_Events" WHERE "seq" = 9`,
    );
    const originalAfter = (original[0] as { a: string }).a;
    await c.sb.exec(
      `UPDATE "Audit_Events" SET "after" = '{"k":999}'::jsonb WHERE "seq" = 9`,
    );
    process.env.AUDIT_ANCHOR_EMAIL = 'anchor@212collectorsclub.test';
    const r = await cron.runScheduled();
    expect(r).toMatchObject({
      status: 'BROKEN',
      brokenSeq: 9,
      anchorEmailSent: true,
    });
    expect(
      err.mock.calls.some((a) =>
        String(a[0]).includes('AUDIT CHAIN BROKEN at seq 9'),
      ),
    ).toBe(true);
    const mail = sendMail.mock.calls.at(-1)?.[0] as { subject: string };
    expect(mail.subject).toContain('VERIFICATION FAILED');
    const vs = await server()
      .get(`${BASE}/verifications`)
      .set(auth())
      .expect(200);
    expect(vs.body.chainBroken).toBe(true);
    expect(vs.body.items[0]).toMatchObject({ result: 'BROKEN', brokenSeq: 9 });
    expect(vs.body.items[0].expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(vs.body.items[0].foundHash).toMatch(/^[0-9a-f]{64}$/);
    const post = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ mode: 'full' })
      .expect(200);
    expect(post.body).toMatchObject({
      ok: false,
      brokenAt: { seq: 9, reason: 'HASH_MISMATCH' },
    });
    // A PARTIAL verification that reads only clean rows must not clear the alert.
    const partial = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ mode: 'full', fromSeq: 10 })
      .expect(200);
    expect(partial.body).toMatchObject({ ok: true, partial: true });
    const stillBroken = await server()
      .get(`${BASE}/verifications`)
      .set(auth())
      .expect(200);
    expect(stillBroken.body.chainBroken).toBe(true);
    // ... nor an incremental one (it trusts the rows before its anchor).
    await server().post(`${BASE}/verify`).set(auth()).send({}).expect(200);
    expect(
      (await server().get(`${BASE}/verifications`).set(auth())).body
        .chainBroken,
    ).toBe(true);
    // A full verification over the UNCHANGED chain is BROKEN again: still broken.
    await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ mode: 'full' })
      .expect(200);
    expect(
      (await server().get(`${BASE}/verifications`).set(auth())).body
        .chainBroken,
    ).toBe(true);
    // Only a later COMPLETE OK clears it (here: the row was put back).
    await c.sb.exec(
      `UPDATE "Audit_Events" SET "after" = '${originalAfter.replace(/'/g, "''")}'::jsonb WHERE "seq" = 9`,
    );
    const full = await server()
      .post(`${BASE}/verify`)
      .set(auth())
      .send({ mode: 'full' })
      .expect(200);
    expect(full.body).toMatchObject({ ok: true, partial: false });
    const cleared = await server()
      .get(`${BASE}/verifications`)
      .set(auth())
      .expect(200);
    expect(cleared.body.chainBroken).toBe(false);
    expect(cleared.body.lastBrokenAt).not.toBeNull(); // the history keeps it
    err.mockRestore();
  });

  it('a verification already running makes the job skip (BUSY), not fail', async () => {
    const holder = await rawClient();
    const err = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(${AUDIT_VERIFY_LOCK_KEY})`,
      );
      expect(await cron.runScheduled()).toMatchObject({ status: 'BUSY' });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
      err.mockRestore();
    }
  });
});
