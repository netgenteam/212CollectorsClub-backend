/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies and pg rows are untyped JSON */
import { randomInt, randomUUID } from 'node:crypto';
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
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AUDIT_CHAIN_LOCK_KEY } from './../src/audit/audit.service.js';
import {
  adminDatabaseUrl,
  createAuditSandbox,
} from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';
import { appCrypto } from './helpers/iddoc-assert.js';

/**
 * Story 20.4 (AC7, AC8): POST /admin/orders/:orderId/reveal-id-doc. The whole app runs with its
 * connection pointed at a SANDBOX schema (`search_path`), so the events never reach the real,
 * immutable `Audit_Events`; the synthetic orders live in the real tables and are removed.
 */
const TAG = randomUUID().slice(0, 8);
const PASS = 'correct-horse-battery-staple-20-4';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const synth = (): string =>
  `9${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

interface Admin {
  id: string;
  token: string;
}
interface Ctx {
  app: NestExpressApplication;
  url: string;
  sb: AuditSandbox;
  prisma: PrismaService;
  savedUrl: string | undefined;
  admins: Admin[];
  orderIds: string[];
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
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('212CollectorsClub API').build(),
    ),
  );
  await app.init();
  // A real listener: supertest closes an unstarted server after the first answer, which resets the
  // other requests of a Promise.all.
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const admins: Admin[] = [];
  for (const n of ['a', 'b']) {
    const username = `e2e-reveal-${n}-${TAG}`;
    const row = await prisma.adminUser.create({
      data: {
        username,
        email: `${username}@212collectorsclub.test`,
        passwordHash,
      },
    });
    const login = await request(base)
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: username, password: PASS })
      .expect(200);
    admins.push({
      id: row.id,
      token: (login.body as { accessToken: string }).accessToken,
    });
  }
  return { app, url: base, sb, prisma, savedUrl, admins, orderIds: [] };
}

async function shutdown(c: Ctx): Promise<void> {
  await c.prisma.order.deleteMany({ where: { id: { in: c.orderIds } } });
  await c.prisma.adminUser.deleteMany({
    where: { id: { in: c.admins.map((a) => a.id) } },
  });
  await c.app.close();
  if (c.savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = c.savedUrl;
  await c.sb.drop();
}

async function mkOrder(
  c: Ctx,
  data: Partial<{
    recipient: string | null;
    buyer: string | null;
    recipientEnc: string | null;
    recipientBlind: string | null;
    buyerEnc: string | null;
    buyerBlind: string | null;
    buyerType: 'V' | 'E' | 'J' | 'P' | 'G' | null;
    legacyPlain: string | null;
  }> = {},
): Promise<string> {
  const r = data.recipient === undefined ? null : data.recipient;
  const b = data.buyer === undefined ? null : data.buyer;
  const rp = r ? appCrypto.protect(r) : null;
  const bp = b ? appCrypto.protect(b) : null;
  const o = await c.prisma.order.create({
    data: {
      status: 'PENDING_VERIFICATION',
      paymentRail: 'PAGO_MOVIL',
      fulfillmentType: 'DELIVERY',
      recipientName: 'Reveal Tester',
      recipientPhone: '04121234567',
      totalUsd: '5.00',
      accessTokenHash: randomUUID(),
      recipientIdDoc: data.legacyPlain ?? null,
      recipientIdDocEnc: data.recipientEnc ?? rp?.enc ?? null,
      recipientIdDocBlind: data.recipientBlind ?? rp?.blind ?? null,
      buyerIdType: data.buyerType ?? (bp?.type as 'V' | null) ?? null,
      buyerIdDocEnc: data.buyerEnc ?? bp?.enc ?? null,
      buyerIdDocBlind: data.buyerBlind ?? bp?.blind ?? null,
    },
  });
  c.orderIds.push(o.id);
  return o.id;
}

const rawClient = async (): Promise<pg.Client> => {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  const cl = new pg.Client({ connectionString: u.toString() });
  await cl.connect();
  return cl;
};

describe('Reveal of the full ID document (e2e, Story 20.4) on a sandbox audit schema', () => {
  let c: Ctx;
  const server = () => request(c.url);
  const reveal = (orderId: string, field: unknown, admin = c.admins[0]) =>
    server()
      .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ field });
  const events = async () =>
    c.sb.exec(
      `SELECT "seq","action","actorType","actorId"::text AS "actorId","entityType","entityId",
              "after","before","reason","requestId"::text AS "requestId",host("ip") AS "ip"
         FROM "Audit_Events" WHERE "action" = 'ID_DOC_REVEALED' ORDER BY "seq"`,
    );
  const count = async () => (await events()).length;

  const recipientNo = synth();
  const buyerNo = synth();
  let orderId: string;

  beforeAll(async () => {
    c = await boot({});
    orderId = await mkOrder(c, {
      recipient: `V-${recipientNo}`,
      buyer: `E-${buyerNo}`,
    });
  }, 90_000);
  afterAll(async () => {
    await shutdown(c);
  });

  it('401 without a token; the order id and the body are not even looked at', async () => {
    await server()
      .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
      .send({ field: 'recipient' })
      .expect(401);
    await server()
      .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
      .set('Authorization', 'Bearer not-a-token')
      .send({ field: 'recipient' })
      .expect(401);
    expect(await count()).toBe(0);
  });

  it('400 for a bad order id, a bad field or an unknown body property: nothing audited', async () => {
    await reveal('not-a-uuid', 'recipient').expect(400);
    await reveal(orderId, 'nope').expect(400);
    await reveal(orderId, undefined).expect(400);
    await server()
      .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
      .set('Authorization', `Bearer ${c.admins[0].token}`)
      .send({ field: 'buyer', extra: 1 })
      .expect(400);
    expect(await count()).toBe(0);
  });

  it('404 ORDER_NOT_FOUND for an unknown order; nothing audited', async () => {
    const res = await reveal(randomUUID(), 'recipient').expect(404);
    expect(res.body.errorCode).toBe('ORDER_NOT_FOUND');
    expect(await count()).toBe(0);
  });

  it('404 ID_DOC_NOT_FOUND for a field with no data (a historical order has no buyer ID); nothing audited', async () => {
    const hist = await mkOrder(c, { recipient: `V-${synth()}` });
    const res = await reveal(hist, 'buyer').expect(404);
    expect(res.body.errorCode).toBe('ID_DOC_NOT_FOUND');
    const empty = await mkOrder(c, {});
    expect((await reveal(empty, 'recipient').expect(404)).body.errorCode).toBe(
      'ID_DOC_NOT_FOUND',
    );
    expect(await count()).toBe(0);
  });

  it('AC7: reveals the value with no-store, and the committed event holds actor/entity/field/requestId/ip, never the value', async () => {
    const res = await reveal(orderId, 'recipient')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);
    expect(res.body).toEqual({ value: `V-${recipientNo}`, unparsed: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(UUID_V4);
    const buyer = await reveal(orderId, 'buyer').expect(200);
    expect(buyer.body.value).toBe(`E-${buyerNo}`);

    const ev = await events();
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      action: 'ID_DOC_REVEALED',
      actorType: 'ADMIN',
      actorId: c.admins[0].id,
      entityType: 'Order',
      entityId: orderId,
      after: { field: 'recipient' },
      before: null,
      requestId: res.headers['x-request-id'],
      ip: '203.0.113.9',
    });
    expect(ev[1]).toMatchObject({ after: { field: 'buyer' } });
    expect(JSON.stringify(ev)).not.toContain(recipientNo);
    expect(JSON.stringify(ev)).not.toContain(buyerNo);
  });

  it('errors are uncacheable too', async () => {
    const res = await reveal(randomUUID(), 'recipient').expect(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the cipher moved from another order is NOT delivered: 500 ID_DOC_INTEGRITY_FAILED, reported, no event', async () => {
    const other = appCrypto.protect(`V-${synth()}`);
    const mine = appCrypto.protect(`V-${synth()}`);
    const moved = await mkOrder(c, {
      recipientEnc: mine?.enc,
      recipientBlind: other?.blind, // the row says "other's" blind, the cipher is another value
    });
    const before = await count();
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const res = await reveal(moved, 'recipient').expect(500);
      expect(res.body.errorCode).toBe('ID_DOC_INTEGRITY_FAILED');
      expect(res.body.details).toEqual({
        field: 'recipient',
        reason: 'BLIND_MISMATCH',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/[VE]-9\d{8}|v1:/);
      const logged = spy.mock.calls.map((x) => String(x[0])).join('\n');
      expect(logged).toContain(`order=${moved}`);
      expect(logged).toContain('field=recipient');
    } finally {
      spy.mockRestore();
    }
    expect(await count()).toBe(before);
  });

  it('a tampered ciphertext and a parsed value with a NULL blind are refused too', async () => {
    const p = appCrypto.protect(`V-${synth()}`);
    const parts = (p?.enc as string).split(':');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`;
    const t = await mkOrder(c, {
      recipientEnc: tampered,
      recipientBlind: p?.blind,
    });
    expect((await reveal(t, 'recipient').expect(500)).body.details.reason).toBe(
      'DECRYPT_FAILED',
    );
    const nb = await mkOrder(c, { recipientEnc: p?.enc, recipientBlind: null });
    expect(
      (await reveal(nb, 'recipient').expect(500)).body.details.reason,
    ).toBe('BLIND_MISSING');
  });

  it('an unparsed legacy value (no type, no blind) is delivered flagged, and the event says so', async () => {
    const legacyNo = synth();
    const p = appCrypto.protect(legacyNo); // no type letter: unparsed, blind null
    expect(p?.blind).toBeNull();
    const o = await mkOrder(c, { recipientEnc: p?.enc, recipientBlind: null });
    const before = await count();
    const res = await reveal(o, 'recipient').expect(200);
    expect(res.body).toEqual({ value: legacyNo, unparsed: true });
    const ev = await events();
    expect(ev).toHaveLength(before + 1);
    expect(ev[ev.length - 1]).toMatchObject({
      after: { field: 'recipient', unparsed: true },
    });
    expect(JSON.stringify(ev)).not.toContain(legacyNo);
  });

  it('no event, no delivery (AC8): when the audit table cannot be written the value is NOT returned (503 AUDIT_UNAVAILABLE)', async () => {
    const before = await count();
    // A CHECK that nothing satisfies, added INSIDE the sandbox table: every INSERT fails. (Never
    // rename or drop the table: unqualified names would fall through to the REAL, immutable one.)
    await c.sb.exec(
      `ALTER TABLE "Audit_Events" ADD CONSTRAINT "e2e_no_insert" CHECK (false) NOT VALID`,
    );
    try {
      const res = await reveal(orderId, 'recipient').expect(503);
      expect(res.body.errorCode).toBe('AUDIT_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain(recipientNo);
    } finally {
      await c.sb.exec(
        `ALTER TABLE "Audit_Events" DROP CONSTRAINT "e2e_no_insert"`,
      );
    }
    expect(await count()).toBe(before);
    await reveal(orderId, 'recipient').expect(200);
    expect(await count()).toBe(before + 1);
  });

  it('no event, no delivery (AC8): chain lock held by someone else => 503 after the bounded wait, no value, no event', async () => {
    const before = await count();
    const holder = await rawClient();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [
      AUDIT_CHAIN_LOCK_KEY,
    ]);
    const t0 = Date.now();
    try {
      const res = await reveal(orderId, 'recipient').expect(503);
      expect(res.body.errorCode).toBe('AUDIT_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain(recipientNo);
      expect(Date.now() - t0).toBeLessThan(9_000);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [
        AUDIT_CHAIN_LOCK_KEY,
      ]);
      await holder.end();
    }
    expect(await count()).toBe(before);
    await reveal(orderId, 'recipient').expect(200);
  }, 30_000);

  it('AC7/AC8: 31 concurrent reveals of one admin (Promise.all): exactly 30 succeed, the 31st is 429 with Retry-After; 30 events, none with the value', async () => {
    const start = await count();
    const room = 30 - start; // this admin already used `start` of the hour
    expect(room).toBeGreaterThan(0);
    // Use a fresh admin (b) so the count is exactly 30 events from a clean slate.
    const admin = c.admins[1];
    const o = await mkOrder(c, {
      recipient: `V-${recipientNo}`,
      buyer: `V-${buyerNo}`,
    });
    const rs = await Promise.all(
      Array.from({ length: 31 }, (_v, i) =>
        reveal(o, i % 2 === 0 ? 'recipient' : 'buyer', admin),
      ),
    );
    const ok = rs.filter((r) => r.status === 200);
    const limited = rs.filter((r) => r.status === 429);
    expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(ok).toHaveLength(30);
    expect(limited).toHaveLength(1);
    expect(limited[0].body.errorCode).toBe('ID_DOC_REVEAL_RATE_LIMITED');
    expect(limited[0].body.details.limitPerHour).toBe(30);
    const retry = Number(limited[0].headers['retry-after']);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThan(3_500);
    expect(retry).toBeLessThanOrEqual(3_600);
    expect(limited[0].headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(limited[0].body)).not.toMatch(/9\d{8}/);
    for (const r of ok) expect(r.body.value).toMatch(/^V-9\d{8}$/);

    const mine = (await events()).filter((e) => e.actorId === admin.id);
    expect(mine).toHaveLength(30);
    expect(JSON.stringify(mine)).not.toContain(recipientNo);
    expect(JSON.stringify(mine)).not.toContain(buyerNo);
    // contiguous chain, nothing lost to the race
    const seqs = (
      await c.sb.exec(`SELECT "seq" FROM "Audit_Events" ORDER BY "seq"`)
    ).map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_v, i) => i + 1));
    // the 32nd is limited as well, and writes nothing
    await reveal(o, 'recipient', admin).expect(429);
    expect((await events()).filter((e) => e.actorId === admin.id)).toHaveLength(
      30,
    );

    // the limit is per admin: admin a still has room
    await reveal(orderId, 'recipient', c.admins[0]).expect(200);
  }, 60_000);

  it('the chain written by the reveals verifies', async () => {
    const res = await server()
      .post('/api/v1/admin/audit/verify')
      .set('Authorization', `Bearer ${c.admins[0].token}`)
      .send({})
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, done: true });
  });

  it('AC9: Swagger documents the error codes of the endpoint', async () => {
    const doc = (await server().get('/api/docs-json').expect(200)).body;
    const op = doc.paths['/api/v1/admin/orders/{orderId}/reveal-id-doc'].post;
    const text = JSON.stringify(op.responses);
    for (const code of [
      'ID_DOC_REVEAL_RATE_LIMITED',
      'ID_DOC_NOT_FOUND',
      'AUDIT_UNAVAILABLE',
      'ID_DOC_INTEGRITY_FAILED',
      'ORDER_NOT_FOUND',
      'INVALID_ADMIN_TOKEN',
    ]) {
      expect(text).toContain(code);
    }
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '429', '500', '503']),
    );
    expect(JSON.stringify(op.requestBody)).toContain('RevealIdDocDto');
  });
});

describe('Reveal limit window (e2e, Story 20.4) on a sandbox WITHOUT triggers (so old rows can be seeded)', () => {
  let c: Ctx;
  const server = () => request(c.url);
  let orderId: string;
  const reveal = (admin: Admin) =>
    server()
      .post(`/api/v1/admin/orders/${orderId}/reveal-id-doc`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ field: 'recipient' });

  /**
   * Seeds `n` ID_DOC_REVEALED rows of `actor` aged `minutes`, directly (the chain is not under test here).
   * Story 20.5: the boot logins now write LOGIN_ADMIN_OK events, so the rows continue after the head.
   */
  async function seed(
    actor: string,
    n: number,
    minutesAgo: number,
  ): Promise<void> {
    await c.sb.exec(
      `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","actorId","action","entityType","entityId",
                                   "hashVersion","prevHash","hash")
       SELECT (SELECT COALESCE(max("seq"), 0) FROM "Audit_Events") + g, clock_timestamp() - make_interval(mins => $2::int) + make_interval(secs => g),
              'ADMIN', $1::uuid, 'ID_DOC_REVEALED', 'Order', 'seed', 1,
              repeat('0', 64), md5($3 || g::text) || md5($3 || g::text || 'x')
         FROM generate_series(1, $4::int) g`,
      [actor, minutesAgo, randomUUID(), n],
    );
  }

  beforeAll(async () => {
    c = await boot({ noTriggers: true });
    orderId = await mkOrder(c, { recipient: `V-${synth()}` });
  }, 90_000);
  afterAll(async () => {
    await shutdown(c);
  });

  it('events older than an hour do not count; the window slides', async () => {
    // Seeded in chronological order (as the chain trigger guarantees in production).
    await seed(c.admins[0].id, 40, 90); // 40 reveals 90 minutes ago: outside the window
    await seed(c.admins[1].id, 29, 59); // 29 reveals about an hour ago: inside, the oldest leaves in ~1 min
    await reveal(c.admins[0]).expect(200);
  });

  it('29 recent events leave room for exactly one more; 30 block, and Retry-After is when the OLDEST frees a slot', async () => {
    const b = c.admins[1];
    await reveal(b).expect(200); // the 30th
    const res = await reveal(b).expect(429);
    const retry = Number(res.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(120);
  });

  it('ID_DOC_REVEAL_MAX_PER_HOUR is honoured (read per request)', async () => {
    const prev = process.env.ID_DOC_REVEAL_MAX_PER_HOUR;
    process.env.ID_DOC_REVEAL_MAX_PER_HOUR = '1';
    try {
      const a = c.admins[0];
      // admin a has exactly 1 recent event (the first test): at the limit of 1
      await reveal(a).expect(429);
      process.env.ID_DOC_REVEAL_MAX_PER_HOUR = '2';
      await reveal(a).expect(200);
      await reveal(a).expect(429);
    } finally {
      if (prev === undefined) delete process.env.ID_DOC_REVEAL_MAX_PER_HOUR;
      else process.env.ID_DOC_REVEAL_MAX_PER_HOUR = prev;
    }
  });
});
