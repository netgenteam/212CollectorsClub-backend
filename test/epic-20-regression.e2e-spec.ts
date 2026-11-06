/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies and pg rows are untyped JSON */
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { RetentionService } from './../src/retention/retention.service.js';
import { RETENTION_ADVISORY_KEY } from './../src/retention/retention.types.js';
import { UsageLogBuffer } from './../src/usage/usage-log.buffer.js';
import { applyUsageLog } from './../src/usage/usage-log.middleware.js';
import { AUDIT_ACTIONS } from './../src/audit/audit-actions.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { E2E_COMPANY, withBuyerId } from './helpers/buyer-id.js';
import { registerConsent } from './helpers/legal-consent.js';
import { appCrypto, expectOnlyEncrypted } from './helpers/iddoc-assert.js';
import {
  hasCedulaShapedNumber,
  letteredTag,
  stripUuids,
} from './helpers/pii-text.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/**
 * Story 20.10: regression of the whole Epic 20 against the real database (a throw-away clone, see
 * `helpers/global-test-db.ts`), running as the LIMITED role when the suite is run that way. It adds no behaviour:
 * it checks, end to end, the owner's constraints (no cedula in clear anywhere, the fiscal record is untouchable, the
 * audit log is immutable and linear) and the lessons accumulated through 20.1..20.9 (real concurrency with
 * `Promise.all`, advisory locks that die with their session, errorCode documented in Swagger).
 *
 * Every row it creates carries this run's tag and is removed at the end; `Audit_Events` is append-only and is never
 * touched (the tamper tests of 20.1 live in a sandbox schema, and a static test below keeps it that way). Synthetic
 * cedulas only.
 */
const BASE = '/api/v1';
// a leading letter: an all-digit tag in GOOD_REASON would trip the anonymization digit-run rule (400)
const TAG = letteredTag(randomUUID().replace(/-/g, ''));
const PASSWORD = 'Correct-horse-20-10!';
const ADMIN_PASSWORD = 'correct-horse-battery-staple-20-10';
/** The sentinel cedula of AC1 (a V number) and the digits of the company RIF of `E2E_COMPANY`. */
const SENTINEL = 'V-87654321';
const SENTINEL_DIGITS = '87654321';
const RIF_DIGITS = '070133805';
const GOOD_REASON = `Solicitud del titular por WhatsApp, ref ${TAG}, 2026-11-05`;
const emailOf = (k: string) => `e2e-2010-${TAG}-${k}@212collectorsclub.test`;
const ROOT = resolve(__dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolvePort(port));
    });
  });
}

interface Booted {
  app: NestExpressApplication;
  prisma: PrismaService;
  base: string;
  close: () => Promise<void>;
}

/** An application on a real listener (`Promise.all` against a supertest-owned server resets sockets). */
async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const merged: Record<string, string> = {
    RETENTION_PURGE_ENABLED: 'true',
    RETENTION_BATCH_SIZE: '10',
    RETENTION_BATCH_PAUSE_MS: '0',
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    applyRequestContext(app);
    // the usage log of main.ts: a plain middleware (the testing module does not mount it by itself)
    applyUsageLog(app, app.get(UsageLogBuffer));
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
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as net.AddressInfo).port;
    return {
      app,
      prisma: app.get(PrismaService),
      base: `http://127.0.0.1:${port}`,
      close: () => app.close(),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const cookieOf = (res: request.Response, name: string): string =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0] as string;

/** Captures everything written to stdout/stderr (where the Nest logger prints) and to `console` while `fn` runs. */
async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ out: string; value: T }> {
  const chunks: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const grab =
    (orig: typeof o) =>
    (c: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return (orig as (...a: unknown[]) => boolean)(c, ...rest);
    };
  process.stdout.write = grab(o);
  process.stderr.write = grab(e);
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      chunks.push(a.map((x) => String(x)).join(' '));
    }),
  );
  try {
    const value = await fn();
    return { out: chunks.join(''), value };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
    for (const s of spies) s.mockRestore();
  }
}

describe('Epic 20 regression (e2e, Story 20.10)', () => {
  let t: Booted;
  let prisma: PrismaService;
  let categoryId: string;
  let mrwId: string;
  let adminId: string;
  let adminToken = '';
  let owner: pg.Client;
  const productIds: string[] = [];
  const emails: string[] = [];
  const customerIds: string[] = [];
  const usageRoutes = new Set<string>();
  let n = 0;

  const server = () => request(t.base);
  const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });
  const sql = <R = Record<string, any>>(q: string, ...p: unknown[]) =>
    prisma.$queryRawUnsafe<R[]>(q, ...p);
  const num = async (q: string, ...p: unknown[]): Promise<number> =>
    Number((await sql<{ n: string }>(q, ...p))[0].n);

  async function mkProduct(stock = 500): Promise<string> {
    n += 1;
    const p = await prisma.product.create({
      data: {
        name: `Reg2010${TAG} ${n}`,
        slug: `reg2010${TAG}-${n}`.toLowerCase(),
        description: 'Created by e2e 20.10.',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '5.00',
        stock,
        heldQty: 0,
        isActive: true,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** register (with the 19.4 consent) -> verified -> login. */
  async function mkCustomer(
    key: string,
    emailOverride?: string,
  ): Promise<{ id: string; email: string; cookie: string }> {
    n += 1;
    const email = emailOverride ?? emailOf(`${key}${n}`);
    if (!emails.includes(email)) emails.push(email);
    await server()
      .post(`${BASE}/auth/register`)
      .send({
        ...registerConsent(),
        email,
        password: PASSWORD,
        name: `Cliente ${key}`,
      })
      .expect(201);
    const c = await prisma.customer.update({
      where: { email },
      data: { emailVerified: true },
    });
    customerIds.push(c.id);
    const res = await server()
      .post(`${BASE}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { id: c.id, email, cookie: cookieOf(res, 'cc_session') };
  }

  const fresh = (recipientDigits: string, over: Record<string, unknown> = {}) =>
    withBuyerId({
      paymentRail: 'pago_movil',
      recipientName: 'Maria Perez',
      recipientPhone: '+58 (412) 123-4567',
      recipientIdDoc: `V${recipientDigits}`,
      deliveryMode: 'home_delivery',
      shippingAgencyId: mrwId,
      state: 'Miranda',
      municipality: 'Baruta',
      parish: 'Las Minas',
      addressLine1: 'Calle 1, Casa 2',
      ...over,
    });

  async function cartCookie(
    productId: string,
    session?: string,
  ): Promise<string> {
    const r = server().post(`${BASE}/cart/items`);
    if (session) void r.set('Cookie', session);
    const res = await r.send({ productId, quantity: 1 }).expect(201);
    return session ?? cookieOf(res, 'cartId');
  }
  async function checkout(
    body: object,
    session?: string,
  ): Promise<request.Response> {
    const pid = await mkProduct();
    const cookie = await cartCookie(pid, session);
    return server().post(`${BASE}/checkout`).set('Cookie', cookie).send(body);
  }

  const head = async (): Promise<number> =>
    num(`SELECT COALESCE(max("seq"), 0)::text AS n FROM "Audit_Events"`);
  /** count + md5 of the whole content of a table (rows as text, in a stable order). */
  const fp = async (table: string, where = 'true'): Promise<string> => {
    const r = (
      await sql<{ n: string; h: string }>(
        `SELECT count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${table}" x WHERE ${where}`,
      )
    )[0];
    return `${r.n}:${r.h}`;
  };

  /** Rows of every base table of `public` whose text form contains `needle`: the "sweep by information_schema". */
  async function sweep(needle: string): Promise<Record<string, number>> {
    const tables = await sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const hits: Record<string, number> = {};
    for (const { table_name: tb } of tables) {
      const c = await num(
        `SELECT count(*)::text AS n FROM "${tb}" x WHERE x::text LIKE $1`,
        `%${needle}%`,
      );
      if (c > 0) hits[tb] = c;
    }
    return hits;
  }

  const reveal = (orderId: string, field: 'recipient' | 'buyer') =>
    server()
      .post(`${BASE}/admin/orders/${orderId}/reveal-id-doc`)
      .set(adminAuth())
      .send({ field });
  const anonymize = (id: string, body: Record<string, unknown>) =>
    server()
      .post(`${BASE}/admin/customers/${id}/anonymize`)
      .set(adminAuth())
      .send(body);
  const runRetention = () =>
    server().post(`${BASE}/admin/retention/run`).set(adminAuth()).send({});

  async function waitRun(runId: string) {
    for (let i = 0; i < 600; i++) {
      const rows = await sql(
        `SELECT * FROM "Retention_Runs" WHERE "id" = $1::uuid`,
        runId,
      );
      if (rows[0] && rows[0].status !== 'RUNNING') {
        const tasks = rows[0].tasks as { name: string; rows: number }[];
        return {
          run: rows[0],
          total: tasks.reduce((s, k) => s + k.rows, 0),
          byTask: Object.fromEntries(tasks.map((k) => [k.name, k.rows])),
        };
      }
      await sleep(100);
    }
    throw new Error(`run ${runId} did not finish`);
  }
  async function runAndWait() {
    const res = await runRetention().expect(202);
    return waitRun(res.body.runId as string);
  }

  /** Sets a terminal status on every order of the account (the anonymization refuses accounts with active orders). */
  const finishOrdersOf = (customerId: string) =>
    prisma.order.updateMany({
      where: { customerId },
      data: { status: 'FULFILLED' },
    });

  /** `count` contact messages older than `age`, tagged so the test (and the cleanup) can find them. */
  async function seedOldContacts(tag: string, count: number, age: string) {
    for (let i = 0; i < count; i++) {
      await sql(
        `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
         VALUES (gen_random_uuid(), 'Viejo', $1, $2, (now() AT TIME ZONE 'UTC') - $3::interval, (now() AT TIME ZONE 'UTC') - $3::interval)`,
        emailOf(`${tag}${i}`),
        `${tag} ${TAG}`,
        age,
      );
    }
  }

  beforeAll(async () => {
    // always rebuilt (incremental): a stale `dist` would test the previous code (the kill -9 block runs the real server)
    execFileSync('pnpm', ['exec', 'nest', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    t = await boot();
    prisma = t.prisma;
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    mrwId = (
      await prisma.shippingAgency.findUniqueOrThrow({ where: { code: 'MRW' } })
    ).id;
    const username = `e2e-2010-${TAG}`;
    const admin = await prisma.adminUser.create({
      data: {
        username,
        email: `${username}@212collectorsclub.test`,
        passwordHash: await argon2.hash(ADMIN_PASSWORD, {
          type: argon2.argon2id,
        }),
      },
    });
    adminId = admin.id;
    const login = await server()
      .post(`${BASE}/admin/auth/login`)
      .send({ usernameOrEmail: username, password: ADMIN_PASSWORD })
      .expect(200);
    adminToken = (login.body as { accessToken: string }).accessToken;
    const u = new URL(adminDatabaseUrl());
    u.searchParams.delete('schema');
    owner = new pg.Client({ connectionString: u.toString() });
    await owner.connect();
  });

  afterAll(async () => {
    const ids = (
      await prisma.customer.findMany({
        where: {
          OR: [
            { id: { in: customerIds } },
            { email: { in: emails } },
            { email: { startsWith: `e2e-2010-${TAG}` } },
          ],
        },
        select: { id: true },
      })
    ).map((c) => c.id);
    const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
    await quiet(
      prisma.order.deleteMany({
        where: {
          OR: [
            { customerId: { in: ids } },
            { lines: { some: { productId: { in: productIds } } } },
          ],
        },
      }),
    );
    await quiet(
      prisma.cart.deleteMany({
        where: {
          OR: [
            { customerId: { in: ids } },
            { items: { some: { productId: { in: productIds } } } },
          ],
        },
      }),
    );
    await quiet(prisma.customer.deleteMany({ where: { id: { in: ids } } }));
    await quiet(
      prisma.contactInquiry.deleteMany({
        where: { message: { contains: TAG } },
      }),
    );
    await quiet(
      prisma.customerVerification.deleteMany({
        where: {
          OR: [{ identifier: { contains: TAG } }, { value: { contains: TAG } }],
        },
      }),
    );
    await quiet(
      prisma.$executeRawUnsafe(
        `DELETE FROM "Usage_Logs" WHERE "route" = ANY($1::text[])`,
        [...usageRoutes],
      ),
    );
    await quiet(
      prisma.product.deleteMany({ where: { id: { in: productIds } } }),
    );
    await quiet(prisma.adminUser.delete({ where: { id: adminId } }));
    await owner.end();
    await t.close();
  });

  // ===================================================================================================================
  describe('AC1: zero cedula in clear (responses, logs, Usage_Logs, Audit_Events, every column)', () => {
    it('a checkout with a sentinel cedula and a RIF leaves it only encrypted, and only the admin reveal returns it', async () => {
      const seen: string[] = []; // every non-admin body
      const rids: string[] = [];
      const note = (res: request.Response): request.Response => {
        seen.push(JSON.stringify(res.body), JSON.stringify(res.headers));
        const rid = res.headers['x-request-id'];
        if (rid) rids.push(rid);
        return res;
      };

      const { out, value } = await captureLogs(async () => {
        // an ACCOUNT: saved address with the sentinel, checkout "as the recipient"
        const c = await mkCustomer('ac1');
        const addr = note(
          await server()
            .post(`${BASE}/auth/addresses`)
            .set('Cookie', c.cookie)
            .send({
              agencyId: mrwId,
              deliveryMode: 'home_delivery',
              recipientName: 'Maria Perez',
              recipientPhone: '+58 (412) 123-4567',
              recipientIdDoc: `v${SENTINEL_DIGITS}`,
              state: 'Miranda',
              municipality: 'Baruta',
              addressLine1: 'Calle 1, Casa 2',
            })
            .expect(201),
        );
        note(
          await server()
            .get(`${BASE}/auth/addresses`)
            .set('Cookie', c.cookie)
            .expect(200),
        );
        const acc = note(
          await checkout(
            withBuyerId({
              paymentRail: 'pago_movil',
              customerAddressId: addr.body.id,
            }),
            c.cookie,
          ),
        );
        expect(acc.status).toBe(201);
        // a GUEST with a company: another recipient cedula and a RIF with its legal name
        const guest = note(
          await checkout({
            ...fresh('99887766'),
            buyerSameAsRecipient: undefined,
            buyerId: E2E_COMPANY.buyerId,
            buyerLegalName: E2E_COMPANY.buyerLegalName,
          }),
        );
        expect(guest.status).toBe(201);
        // the views of the customer and the public lookups
        for (const path of [
          `/orders/${acc.body.orderId}`,
          `/orders/${acc.body.orderId}/history`,
        ]) {
          note(
            await server()
              .get(`${BASE}${path}`)
              .set('Authorization', `Bearer ${acc.body.orderAccessToken}`)
              .expect(200),
          );
        }
        note(
          await server()
            .get(`${BASE}/orders/${guest.body.orderId}`)
            .set('Authorization', `Bearer ${guest.body.orderAccessToken}`)
            .expect(200),
        );
        note(
          await server()
            .get(`${BASE}/auth/orders`)
            .set('Cookie', c.cookie)
            .expect(200),
        );
        note(
          await server()
            .get(`${BASE}/auth/orders/${acc.body.orderId}`)
            .set('Cookie', c.cookie)
            .expect(200),
        );
        note(
          await server()
            .get(`${BASE}/auth/me`)
            .set('Cookie', c.cookie)
            .expect(200),
        );
        // the admin views carry only the masked form
        const adminSeen: string[] = [];
        for (const path of [
          `/admin/orders/${acc.body.orderId}`,
          `/admin/orders/${guest.body.orderId}`,
          `/admin/orders`,
          `/admin/customers/${c.id}`,
        ]) {
          const r = await server()
            .get(`${BASE}${path}`)
            .set(adminAuth())
            .expect(200);
          adminSeen.push(JSON.stringify(r.body));
          rids.push(r.headers['x-request-id']);
        }
        const found = await server()
          .post(`${BASE}/admin/orders/search`)
          .set(adminAuth())
          .send({ idDoc: SENTINEL })
          .expect(200);
        adminSeen.push(JSON.stringify(found.body));
        return {
          acc: acc.body,
          guest: guest.body,
          customer: c,
          adminSeen,
        };
      });

      // 1. responses and logs
      for (const body of seen) {
        expect(body).not.toContain(SENTINEL_DIGITS);
        expect(body).not.toContain(RIF_DIGITS);
        expect(body).not.toContain('99887766');
      }
      for (const body of value.adminSeen) {
        expect(body).not.toContain(SENTINEL_DIGITS);
        expect(body).not.toContain(RIF_DIGITS);
      }
      expect(out).not.toContain(SENTINEL_DIGITS);
      expect(out).not.toContain(RIF_DIGITS);
      expect(out).not.toContain('99887766');

      // 2. the stored form: only `...Enc`, plain columns NULL, decryptable and equal to the sentinel
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: value.acc.orderId },
      });
      expectOnlyEncrypted(order, SENTINEL);
      expect(
        appCrypto.checkStored(order.buyerIdDocEnc as string, {
          expectedPlain: SENTINEL,
          blind: order.buyerIdDocBlind,
        }),
      ).toBe('ok');
      const company = await prisma.order.findUniqueOrThrow({
        where: { id: value.guest.orderId },
      });
      expect(company.buyerLegalName).toBe(E2E_COMPANY.buyerLegalName);
      expect(
        appCrypto.checkStored(company.buyerIdDocEnc as string, {
          expectedPlain: 'J-070133805',
          blind: company.buyerIdDocBlind,
        }),
      ).toBe('ok');
      const saved = await prisma.customerAddress.findFirstOrThrow({
        where: { customerId: value.customer.id },
      });
      expect(saved.recipientIdDoc).toBeNull();
      expect(
        appCrypto.checkStored(saved.recipientIdDocEnc as string, {
          expectedPlain: SENTINEL,
          blind: saved.recipientIdDocBlind,
        }),
      ).toBe('ok');

      // 3. Usage_Logs: wait for the buffer to write what these requests produced, then sweep EVERY table
      let logged = 0;
      for (let i = 0; i < 60; i++) {
        logged = await num(
          `SELECT count(*)::text AS n FROM "Usage_Logs" WHERE "requestId" = ANY($1::uuid[])`,
          rids,
        );
        if (logged === rids.length) break;
        await sleep(250);
      }
      expect(logged).toBe(rids.length);
      for (const needle of [SENTINEL_DIGITS, RIF_DIGITS, '99887766']) {
        expect(await sweep(needle), `tables holding ${needle}`).toEqual({});
      }

      // 4. the mandatory invoice cedula is still available: the audited admin reveal returns it
      const r1 = await reveal(value.acc.orderId, 'recipient').expect(200);
      expect(r1.body).toEqual({ value: SENTINEL, unparsed: false });
      const r2 = await reveal(value.acc.orderId, 'buyer').expect(200);
      expect(r2.body).toEqual({ value: SENTINEL, unparsed: false }); // buyerSameAsRecipient
      // ... and the audit events of the reveal do not hold the value
      expect(
        await num(
          `SELECT count(*)::text AS n FROM "Audit_Events" WHERE "action" = 'ID_DOC_REVEALED' AND "entityId" = $1`,
          value.acc.orderId,
        ),
      ).toBe(2);
      expect(await sweep(SENTINEL_DIGITS)).toEqual({});
    });
  });

  // ===================================================================================================================
  describe('AC2: the fiscal record is untouchable (anonymization and retention)', () => {
    it('after anonymizing an account and after a retention run over old seeded data, Orders, lines, proofs, consents and the audit log keep count and hash', async () => {
      const c = await mkCustomer('ac2');
      const first = await checkout(fresh('91111111'), c.cookie);
      expect(first.status).toBe(201);
      const second = await checkout(fresh('92222222'), c.cookie);
      expect(second.status).toBe(201);
      await finishOrdersOf(c.id);
      // a proof of payment on one of the orders (row only: neither the retention nor the anonymization touch it)
      await prisma.proofOfPayment.create({
        data: {
          orderId: first.body.orderId,
          filePath: `proof-of-payment/e2e2010-${TAG}.png`,
          mimeType: 'image/png',
          sizeBytes: 30,
        },
      });

      // old data for the retention to purge (so the run really deletes something)
      await seedOldContacts('ac2old', 3, '30 months');
      await sql(
        `INSERT INTO "Customer_Sessions" ("id","token","expiresAt","ipAddress","userAgent","userId","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'UTC') - interval '30 days', '203.0.113.7', 'e2e', $2::uuid, (now() AT TIME ZONE 'UTC') - interval '120 days', (now() AT TIME ZONE 'UTC') - interval '30 days')`,
        `ac2-${TAG}-sess`,
        c.id,
      );
      const oldUsageRoute = `/zz2010/${TAG}/old`;
      usageRoutes.add(oldUsageRoute);
      await sql(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","ip","requestId")
         VALUES (now() - interval '9 days','GET',$1,200,1,'ANON','203.0.113.9'::inet,gen_random_uuid())`,
        oldUsageRoute,
      );

      const tables = [
        'Orders',
        'Order_Lines',
        'Proof_Of_Payments',
        'Consent_Records',
      ];
      const headBefore = await head();
      const before: Record<string, string> = {};
      for (const tb of tables) before[tb] = await fp(tb);
      const auditBefore = await fp('Audit_Events', `"seq" <= ${headBefore}`);

      await anonymize(c.id, {
        confirmEmail: c.email,
        reason: GOOD_REASON,
      }).expect(200);
      for (const tb of tables)
        expect(await fp(tb), `${tb} after the anonymization`).toBe(before[tb]);
      expect(await fp('Audit_Events', `"seq" <= ${headBefore}`)).toBe(
        auditBefore,
      );

      const run = await runAndWait();
      expect(run.run.status).toBe('OK');
      expect(run.byTask.contact_inquiries).toBeGreaterThanOrEqual(3);
      expect(
        await num(
          `SELECT count(*)::text AS n FROM "Usage_Logs" WHERE "route" = $1`,
          oldUsageRoute,
        ),
      ).toBe(0);
      for (const tb of tables)
        expect(await fp(tb), `${tb} after the retention run`).toBe(before[tb]);
      expect(await fp('Audit_Events', `"seq" <= ${headBefore}`)).toBe(
        auditBefore,
      );

      // the cedula of the recipient and of the buyer is still revealable after both
      const r = await reveal(first.body.orderId, 'recipient').expect(200);
      expect(r.body.value).toBe('V-91111111');
      const b = await reveal(second.body.orderId, 'buyer').expect(200);
      expect(b.body.value).toBe('V-92222222'); // buyerSameAsRecipient
    });
  });

  // ===================================================================================================================
  describe('AC3: register -> checkout -> anonymize -> login fails -> the email registers again', () => {
    it('follows the whole flow, with the warnings (409 active order, 400 without confirmation) and one CUSTOMER_ANONYMIZED with no clear email', async () => {
      const c = await mkCustomer('ac3');
      const order = await checkout(fresh('93333333'), c.cookie);
      expect(order.status).toBe(201);
      const stored = await prisma.order.findUniqueOrThrow({
        where: { id: order.body.orderId },
      });
      expect(stored.buyerIdDocBlind).toBe(stored.recipientIdDocBlind); // buyerSameAsRecipient

      // an active order blocks it
      const blocked = await anonymize(c.id, {
        confirmEmail: c.email,
        reason: GOOD_REASON,
      }).expect(409);
      expect(blocked.body.errorCode).toBe('ACCOUNT_HAS_ACTIVE_ORDERS');
      // no confirmation / no reason: 400 and nothing changes
      await anonymize(c.id, { reason: GOOD_REASON }).expect(400);
      await anonymize(c.id, { confirmEmail: c.email }).expect(400);
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
          .anonymizedAt,
      ).toBeNull();
      await server().get(`${BASE}/auth/me`).set('Cookie', c.cookie).expect(200);

      await finishOrdersOf(c.id);
      await anonymize(c.id, {
        confirmEmail: c.email,
        reason: GOOD_REASON,
      }).expect(200);

      // login fails like an unknown email; the session of before is dead
      const l = await server()
        .post(`${BASE}/auth/login`)
        .send({ email: c.email, password: PASSWORD })
        .expect(401);
      expect(l.body.errorCode).toBe('INVALID_CUSTOMER_CREDENTIALS');
      await server().get(`${BASE}/auth/me`).set('Cookie', c.cookie).expect(401);

      // the email registers again: a NEW account that inherits nothing
      const again = await mkCustomer('ac3again', c.email);
      expect(again.id).not.toBe(c.id);
      const mine = await server()
        .get(`${BASE}/auth/orders`)
        .set('Cookie', again.cookie)
        .expect(200);
      expect(JSON.stringify(mine.body)).not.toContain(order.body.orderId);
      expect(
        await prisma.order.count({ where: { customerId: again.id } }),
      ).toBe(0);
      // the old orders stayed with the anonymized account
      expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(1);

      // exactly one event, with no email in clear
      const ev = await sql<{ t: string }>(
        `SELECT a::text AS t FROM "Audit_Events" a WHERE "action" = 'CUSTOMER_ANONYMIZED' AND "entityId" = $1`,
        c.id,
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].t.toLowerCase()).not.toContain(c.email.toLowerCase());
      expect(ev[0].t.toLowerCase()).not.toContain(`e2e-2010-${TAG}-ac3`);
    });
  });

  // ===================================================================================================================
  describe('AC4: the audit log', () => {
    it('static coverage: every action with an `emittedBy` is recorded somewhere in src/', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          if (e.name === 'generated' || e.name === 'node_modules') return [];
          const p = join(dir, e.name);
          return e.isDirectory()
            ? walk(p)
            : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
              ? [p]
              : [];
        });
      const sources = walk(join(ROOT, 'src'))
        .filter((p) => !p.endsWith(join('audit', 'audit-actions.ts')))
        .map((p) => readFileSync(p, 'utf8'))
        .join('\n');
      const missing = Object.entries(AUDIT_ACTIONS)
        .filter(([, meta]) => (meta as { emittedBy?: string }).emittedBy)
        .map(([name]) => name)
        .filter((name) => !sources.includes(`'${name}'`));
      // the only actions without an emitter are the ones `audit-coverage.spec.ts` justifies one by one (no flow exists
      // to emit them: no refund route, no admin creation/disable/role/credential endpoint, A104)
      const spec = readFileSync(
        join(ROOT, 'test/audit-coverage.spec.ts'),
        'utf8',
      );
      const block = /const PENDING_JUSTIFIED[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
        spec,
      );
      expect(block).not.toBeNull();
      const justified = [
        ...(block as RegExpExecArray)[1].matchAll(/^ {2}([A-Z_]+):/gm),
      ]
        .map((m) => m[1])
        .sort();
      expect(justified.length).toBeGreaterThan(0);
      expect([...missing].sort()).toEqual(justified);
      // and the emitters really call record()/add() (audit-coverage.spec.ts goes file by file)
      expect(sources).toMatch(/\.\s*record\s*\(/);
      expect(sources).toMatch(/\baudit\s*\.\s*add\s*\(/);
    });

    it('the tamper tests run in a sandbox schema: no test touches the real Audit_Events with UPDATE, DELETE, TRUNCATE or trigger changes', () => {
      const dir = join(ROOT, 'test');
      const specs = readdirSync(dir).filter(
        (f) => f.endsWith('.e2e-spec.ts') || f.endsWith('.spec.ts'),
      );
      const offenders: string[] = [];
      for (const f of specs) {
        if (f === 'epic-20-regression.e2e-spec.ts') continue;
        const text = readFileSync(join(dir, f), 'utf8');
        const touches =
          /(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|ALTER\s+TABLE|DROP\s+TABLE)\s+"Audit_Events"|DISABLE\s+TRIGGER/i.test(
            text,
          );
        if (touches && !/audit-sandbox|createAuditSandbox|sandbox/i.test(text))
          offenders.push(f);
      }
      expect(offenders).toEqual([]);
      // and the sandbox helper refuses a table that is not in an `audit_t_*` schema
      const helper = readFileSync(
        join(dir, 'helpers/audit-sandbox.ts'),
        'utf8',
      );
      expect(helper).toMatch(/assertSandboxTable/);
      expect(helper).toMatch(/SANDBOX_PREFIX/);
    });

    it('verify is OK after a battery of actions from the whole epic with REAL concurrency (Promise.all), and the chain is linear', async () => {
      const cs = await Promise.all(
        ['a', 'b', 'c', 'd'].map((k) => mkCustomer(`ac4${k}`)),
      );
      // concurrent audited writes of different kinds: checkouts (account and guest), reveals, anonymizations
      const checks = await Promise.all([
        ...cs.map((c, i) => checkout(fresh(`9440000${i}`), c.cookie)),
        ...Array.from({ length: 4 }, (_, i) => checkout(fresh(`9450000${i}`))),
      ]);
      for (const r of checks) expect(r.status).toBe(201);
      const orderIds = checks.map((r) => r.body.orderId as string);
      const revealed = await Promise.all(
        orderIds.slice(0, 4).map((id) => reveal(id, 'recipient')),
      );
      for (const r of revealed) expect(r.status).toBe(200);
      for (const c of cs.slice(0, 2)) await finishOrdersOf(c.id);
      const anon = await Promise.all(
        cs
          .slice(0, 2)
          .map((c) =>
            anonymize(c.id, { confirmEmail: c.email, reason: GOOD_REASON }),
          ),
      );
      for (const r of anon) expect(r.status).toBe(200);

      const verify = await server()
        .post(`${BASE}/admin/audit/verify`)
        .set(adminAuth())
        .send({})
        .expect(200);
      expect(verify.body.ok).toBe(true);
      expect(verify.body.done).toBe(true);
      // a single linear chain: contiguous seq and every prevHash is the previous hash
      const broken = await num(
        `SELECT count(*)::text AS n FROM (
           SELECT "seq", "prevHash", lag("hash") OVER (ORDER BY "seq") AS ph, lag("seq") OVER (ORDER BY "seq") AS ps
             FROM "Audit_Events") x
          WHERE x.ps IS NOT NULL AND (x."prevHash" <> x.ph OR x."seq" <> x.ps + 1)`,
      );
      expect(broken).toBe(0);
      // the events of the battery exist (the writes were audited, not skipped)
      expect(
        await num(
          `SELECT count(*)::text AS n FROM "Audit_Events" WHERE "action" = 'ID_DOC_REVEALED' AND "entityId" = ANY($1::text[])`,
          orderIds.slice(0, 4),
        ),
      ).toBe(4);
      const h = await server()
        .get(`${BASE}/admin/audit/head`)
        .set(adminAuth())
        .expect(200);
      expect(Number(h.body.seq)).toBeGreaterThanOrEqual(await head());
    });

    it('the 7 days: Usage_Logs older than 7 days are purged, those of 6 days and the whole audit log are not', async () => {
      const route = `/zz2010/${TAG}/seven`;
      usageRoutes.add(route);
      for (const age of ['8 days', '10 days', '6 days', '1 hour']) {
        await sql(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","ip","requestId")
           VALUES (now() - $1::interval,'GET',$2,200,1,'ANON','203.0.113.10'::inet,gen_random_uuid())`,
          age,
          route,
        );
      }
      // the audit log cannot be dated (immutable): the claim is that a run never changes a row of it
      const h0 = await head();
      const audit0 = await fp('Audit_Events', `"seq" <= ${h0}`);
      const run = await runAndWait();
      expect(run.run.status).toBe('OK');
      expect(
        await num(
          `SELECT count(*)::text AS n FROM "Usage_Logs" WHERE "route" = $1`,
          route,
        ),
      ).toBe(2); // the 6 days and the 1 hour
      expect(await fp('Audit_Events', `"seq" <= ${h0}`)).toBe(audit0);
    });
  });

  // ===================================================================================================================
  describe('AC5: retention (idempotent, one at a time, audited without PII) and the usage log under chaos', () => {
    it('two runs in a row: the second affects 0 rows; RETENTION_PURGE_RUN is written with no PII', async () => {
      await seedOldContacts('idem', 12, '40 months');
      const first = await runAndWait();
      expect(first.run.status).toBe('OK');
      expect(first.total).toBeGreaterThanOrEqual(12);
      const second = await runAndWait();
      expect(second.run.status).toBe('OK');
      expect(second.total).toBe(0);

      const ev = await sql<{ t: string }>(
        `SELECT a::text AS t FROM "Audit_Events" a WHERE "action" = 'RETENTION_PURGE_RUN' AND "entityId" = $1`,
        second.run.id,
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].t).not.toMatch(/@/); // no email
      expect(ev[0].t).not.toContain('203.0.113.'); // no IP of a purged row
      // no cedula-shaped number (the random UUIDs of the row are removed first: they can hold an 8-digit group)
      expect(hasCedulaShapedNumber(ev[0].t)).toBe(false);
      for (const digits of [
        SENTINEL_DIGITS,
        RIF_DIGITS,
        '91111111',
        '92222222',
      ]) {
        expect(stripUuids(ev[0].t)).not.toContain(digits);
      }
      expect(stripUuids(ev[0].t)).not.toContain(TAG);
    });

    it('four runs at the same time on one instance: exactly one 202, the others 409 RETENTION_ALREADY_RUNNING', async () => {
      await seedOldContacts('conc', 25, '40 months');
      const results = await Promise.all(
        Array.from({ length: 4 }, () => runRetention()),
      );
      expect(results.filter((r) => r.status === 202)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 202)) {
        expect(r.status).toBe(409);
        expect(r.body.errorCode).toBe('RETENTION_ALREADY_RUNNING');
      }
      const winner = results.find((r) => r.status === 202)!;
      await waitRun(winner.body.runId as string);
      expect(
        await num(
          `SELECT count(*)::text AS n FROM "Retention_Runs" WHERE "status" = 'RUNNING'`,
        ),
      ).toBe(0);
    });

    it('chaos: with Usage_Logs locked by someone else every request still answers 200, and once released the log works again', async () => {
      const b = await boot({
        USAGE_LOG_FLUSH_MS: '50',
        USAGE_LOG_FLUSH_BATCH: '20',
        USAGE_LOG_BUFFER_MAX: '100',
      });
      try {
        await owner.query('BEGIN');
        try {
          await owner.query('LOCK TABLE "Usage_Logs" IN ACCESS EXCLUSIVE MODE');
          const results = await Promise.all(
            Array.from({ length: 150 }, () =>
              request(b.base).get(`${BASE}/categories`),
            ),
          );
          expect(results.every((r) => r.status === 200)).toBe(true);
        } finally {
          await owner.query('ROLLBACK');
        }
        const rid = (await request(b.base).get(`${BASE}/categories`)).headers[
          'x-request-id'
        ];
        let seen = 0;
        for (let i = 0; i < 60 && seen === 0; i++) {
          seen = await num(
            `SELECT count(*)::text AS n FROM "Usage_Logs" WHERE "requestId" = $1::uuid`,
            rid,
          );
          if (seen === 0) await sleep(250);
        }
        expect(seen).toBe(1);
      } finally {
        await b.close();
      }
    });
  });

  // ===================================================================================================================
  describe('kill -9 in the middle of a retention run (real server process)', () => {
    it('the advisory lock dies with its session: a second instance is refused while it lives, and a new run takes the lock after the kill', async () => {
      const key = RETENTION_ADVISORY_KEY;
      const tag = 'kill';
      await seedOldContacts(tag, 45, '50 months');
      const mine = () =>
        num(
          `SELECT count(*)::text AS n FROM "Contact_Inquiries" WHERE "message" = $1`,
          `${tag} ${TAG}`,
        );
      const lockHolders = () =>
        owner.query<{ pid: number; app: string }>(
          `SELECT l.pid, a.application_name AS app
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 0 AND l.objid = $1`,
          [key],
        );
      // no one holds it now
      expect((await lockHolders()).rows).toHaveLength(0);

      const port = await freePort();
      const child: ChildProcess = spawn('node', ['dist/main.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          FX_REFRESH_ENABLED: 'false',
          RETENTION_PURGE_ENABLED: 'true',
          RETENTION_BATCH_SIZE: '10',
          // 10 s between two batches: the run stays in flight, between batches, for as long as it takes to kill it
          RETENTION_BATCH_PAUSE_MS: '10000',
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout?.on('data', (d: Buffer) => (log += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (log += d.toString()));
      const exited = new Promise<NodeJS.Signals | null>((r) =>
        child.on('exit', (_code, signal) => r(signal)),
      );
      try {
        for (let i = 0; ; i++) {
          try {
            await new Promise<void>((res, rej) => {
              const s = net.connect(port, '127.0.0.1', () => {
                s.destroy();
                res();
              });
              s.on('error', rej);
            });
            break;
          } catch {
            if (i > 200) throw new Error(`server did not start:\n${log}`);
            await sleep(200);
          }
        }
        const started = await request(`http://127.0.0.1:${port}`)
          .post(`${BASE}/admin/retention/run`)
          .set(adminAuth())
          .send({});
        expect(started.status, log).toBe(202);
        const runId = started.body.runId as string;

        // mid-run: the first batch is gone (10 of 45 rows), the other 35 wait behind the pause
        let remaining = await mine();
        for (let i = 0; i < 200 && remaining === 45; i++) {
          await sleep(100);
          remaining = await mine();
        }
        expect(remaining).toBeLessThan(45);
        expect(remaining).toBeGreaterThan(0);

        // the lock belongs to a session of the CHILD (a dedicated `retention-lock` connection)
        const held = (await lockHolders()).rows;
        expect(held).toHaveLength(1);
        expect(held[0].app).toBe('retention-lock');
        const lockPid = held[0].pid;
        expect(
          (
            await sql(
              `SELECT status FROM "Retention_Runs" WHERE "id" = $1::uuid`,
              runId,
            )
          )[0].status,
        ).toBe('RUNNING');
        // another instance (this process) is refused while it lives
        const busy = await t.app.get(RetentionService).start('MANUAL', adminId);
        expect(busy.kind).toBe('busy');
        await runRetention().expect(409);

        child.kill('SIGKILL');
        expect(await exited).toBe('SIGKILL');

        // Postgres notices the dead client and releases every lock of that session
        let alive = 1;
        for (let i = 0; i < 100 && alive > 0; i++) {
          alive = Number(
            (
              await owner.query(
                `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1`,
                [lockPid],
              )
            ).rows[0].n,
          );
          if (alive > 0) await sleep(100);
        }
        expect(alive, 'the session of the killed process is gone').toBe(0);
        expect((await lockHolders()).rows).toHaveLength(0);
        // no advisory lock of any kind is left by the killed process (the audit chain lock is per transaction)
        expect(
          Number(
            (
              await owner.query(
                `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
              )
            ).rows[0].n,
          ),
        ).toBe(0);
        // the run it left behind is still RUNNING: only the next run reconciles it
        expect(
          (
            await sql(
              `SELECT status FROM "Retention_Runs" WHERE "id" = $1::uuid`,
              runId,
            )
          )[0].status,
        ).toBe('RUNNING');

        // a new run takes the lock, marks the orphan FAILED/INTERRUPTED and finishes the work
        const next = await runAndWait();
        expect(next.run.status).toBe('OK');
        const orphan = (
          await sql(
            `SELECT "status","errorSummary" FROM "Retention_Runs" WHERE "id" = $1::uuid`,
            runId,
          )
        )[0];
        expect(orphan.status).toBe('FAILED');
        expect(orphan.errorSummary).toMatch(/INTERRUPTED/);
        expect(await mine()).toBe(0);
        expect((await lockHolders()).rows).toHaveLength(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await exited;
      }
    });
  });

  // ===================================================================================================================
  describe('AC7: Swagger documents the errorCode of every route the epic added', () => {
    it('/api/docs-json names every errorCode of the epic and each failing response of the epic routes cites one', async () => {
      const doc = (await server().get('/api/docs-json').expect(200)).body as {
        paths: Record<
          string,
          Record<
            string,
            {
              description?: string;
              responses?: Record<string, { description?: string }>;
            }
          >
        >;
      };
      const text = JSON.stringify(doc);
      const codes = [
        'ANONYMIZE_CONFIRMATION_MISMATCH',
        'ANONYMIZE_REASON_REQUIRED',
        'ANONYMIZE_BUSY',
        'ACCOUNT_HAS_ACTIVE_ORDERS',
        'REASON_CONTAINS_ID_DOC',
        'REASON_CONTAINS_PERSONAL_DATA',
        'BUYER_ID_REQUIRED',
        'BUYER_ID_INVALID',
        'ID_DOC_INTEGRITY_FAILED',
        'ID_DOC_NOT_FOUND',
        'ID_DOC_IN_URL_NOT_ALLOWED',
        'ID_DOC_REVEAL_RATE_LIMITED',
        'ID_DOC_FILTER_INVALID',
        'AUDIT_UNAVAILABLE',
        'RETENTION_ALREADY_RUNNING',
        'RETENTION_DISABLED',
        'USAGE_FILTER_INVALID',
        'USAGE_QUERY_TIMEOUT',
      ];
      expect(codes.filter((c) => !text.includes(c))).toEqual([]);

      const epicPrefixes = [
        '/api/v1/admin/audit',
        '/api/v1/admin/retention',
        '/api/v1/admin/customers',
        '/api/v1/admin/orders/search',
        '/api/v1/admin/orders/{orderId}/reveal-id-doc',
      ];
      const cites = (s?: string) =>
        /errorCode|\b[A-Z]{3,}(_[A-Z]+)+\b/.test(s ?? '');
      const undocumented: string[] = [];
      let routes = 0;
      for (const [path, ops] of Object.entries(doc.paths)) {
        if (!epicPrefixes.some((p) => path.startsWith(p))) continue;
        for (const [method, op] of Object.entries(ops)) {
          routes += 1;
          const failing = Object.entries(op.responses ?? {}).filter(
            ([status]) => Number(status) >= 400,
          );
          const ok =
            failing.length > 0 &&
            (failing.some(([, r]) => cites(r.description)) ||
              cites(op.description));
          if (!ok) undocumented.push(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(routes).toBeGreaterThanOrEqual(15);
      expect(undocumented).toEqual([]);
    });
  });
});
