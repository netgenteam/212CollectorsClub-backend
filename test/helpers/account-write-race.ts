import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from './../../src/app.module.js';
import { applyRequestContext } from './../../src/common/request-id.middleware.js';
import { createGlobalValidationPipe } from './../../src/common/global-validation-pipe.js';
import { PrismaService } from './../../src/prisma/prisma.service.js';
import { adminDatabaseUrl } from './audit-sandbox.js';
import { appCrypto } from './iddoc-assert.js';
import { registerConsent } from './legal-consent.js';

/**
 * Story 20.6 (D1): a harness shared by `customer-account-write-lock.e2e-spec.ts` (deterministic, one
 * test per route) and `customer-account-write-lock.perf.spec.ts` (random, repeated). It boots the
 * app on a real listener, creates synthetic customers (cleaned in `close`) and offers the one trick
 * that makes the race deterministic: hold a `FOR UPDATE` on a row of the account's address book from
 * a SECOND connection, so the anonymization (which takes `FOR UPDATE` on the Customers row and then
 * deletes the addresses) is blocked INSIDE its transaction while the request under test arrives.
 */
export const BASE = '/api/v1';
const PASS = 'correct-horse-battery-staple-20-6b';
const CPASS = 'correct-horse-battery-20-6b';
export const GOOD_REASON = (tag: string) =>
  `Solicitud del titular por WhatsApp, ref ${tag}, 2026-11-04`;

export interface Cust {
  id: string;
  email: string;
  cookie: string;
  addrId: string;
}

export interface RoundResult {
  c: Cust;
  anon: { status: number; body: Record<string, unknown> };
  results: { kind: string; status: number; body: Record<string, unknown> }[];
  left: Record<string, unknown>;
}

export async function bootHarness(tag: string) {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
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
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const prisma = app.get(PrismaService);
  const server = () => request(base);
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const guestCartIds: string[] = [];
  const guestWishlistIds: string[] = [];
  const category = await prisma.category.findFirstOrThrow();
  const agency = await prisma.shippingAgency.findFirstOrThrow({
    where: { isActive: true, allowsHomeDelivery: true },
  });
  const admin = await prisma.adminUser.create({
    data: {
      username: `e2e-206b-${tag}`,
      email: `e2e-206b-${tag}@212collectorsclub.test`,
      passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
    },
  });
  const login = await server()
    .post(`${BASE}/admin/auth/login`)
    .send({ usernameOrEmail: `e2e-206b-${tag}`, password: PASS })
    .expect(200);
  const token = (login.body as { accessToken: string }).accessToken;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

  let n = 0;
  async function mkCustomer(
    key: string,
    o: { verified?: boolean } = {},
  ): Promise<Cust> {
    n += 1;
    const email = `e2e-206b-${tag}-${key}${n}@212collectorsclub.test`;
    await server()
      .post(`${BASE}/auth/register`)
      .send({
        ...registerConsent(),
        email,
        password: CPASS,
        name: `Cliente ${key}`,
      })
      .expect(201);
    const c = await prisma.customer.update({
      where: { email },
      data: { emailVerified: o.verified ?? true, phone: '04121230000' },
    });
    customerIds.push(c.id);
    const res = await server()
      .post(`${BASE}/auth/login`)
      .send({ email, password: CPASS })
      .expect(200);
    const cookie = ((res.headers['set-cookie'] as unknown as string[]) ?? [])
      .find((x) => x.startsWith('cc_session='))
      ?.split(';')[0] as string;
    // the address the second connection will hold
    const addr = await prisma.customerAddress.create({
      data: {
        customerId: c.id,
        agencyId: agency.id,
        recipientName: 'Direccion Sintetica',
        recipientPhone: '04121111111',
        recipientIdDocEnc: appCrypto.protect('V-91234567')?.enc,
        recipientIdDocBlind: appCrypto.protect('V-91234567')?.blind,
        deliveryMode: 'HOME_DELIVERY',
        state: 'Miranda',
        municipality: 'Chacao',
        addressLine1: 'Calle 1, Casa 2',
        isDefault: true,
      },
    });
    return { id: c.id, email, cookie, addrId: addr.id };
  }

  async function mkProduct(stock = 5): Promise<string> {
    n += 1;
    const p = await prisma.product.create({
      data: {
        name: `AnonB${tag} ${n}`,
        slug: `anonb${tag}-${n}`.toLowerCase(),
        description: 'Created by e2e 20.6 (account write lock).',
        franchise: 'NARUTO',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '5.00',
        stock,
        heldQty: 0,
        isActive: true,
        categoryId: category.id,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** A cart / wishlist that belongs to nobody (the cookie of a guest). */
  async function mkGuestCart(productId: string): Promise<string> {
    const cart = await prisma.cart.create({
      data: {
        expiresAt: new Date(Date.now() + 86_400_000),
        items: { create: [{ productId, quantity: 1 }] },
      },
    });
    guestCartIds.push(cart.id);
    return cart.id;
  }
  async function mkGuestWishlist(productId: string): Promise<string> {
    const wl = await prisma.wishlist.create({
      data: {
        expiresAt: new Date(Date.now() + 86_400_000),
        items: { create: [{ productId }] },
      },
    });
    guestWishlistIds.push(wl.id);
    return wl.id;
  }

  const anonymize = (id: string, email: string): Promise<request.Response> =>
    server()
      .post(`${BASE}/admin/customers/${id}/anonymize`)
      .set(auth())
      .send({ confirmEmail: email, reason: GOOD_REASON(tag) })
      .then((r) => r);

  /** Polls pg_stat_activity until some backend is waiting on a lock with a statement like `pattern`. */
  async function waitBlocked(pattern: string, timeoutMs = 8_000) {
    const t0 = Date.now();
    for (;;) {
      const r = await sql(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1
            AND pid <> pg_backend_pid()`,
        [pattern],
      );
      if (Number(r[0].n) > 0) return;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`nothing is waiting on a lock for ${pattern}`);
      }
      await new Promise((res) => setTimeout(res, 25));
    }
  }

  /** Holds a FOR UPDATE on the address row from another connection. */
  async function holdAddress(addrId: string) {
    const u = new URL(adminDatabaseUrl());
    u.searchParams.delete('schema');
    const holder = new pg.Client({ connectionString: u.toString() });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      `SELECT 1 FROM "Customer_Addresses" WHERE "id" = $1::uuid FOR UPDATE`,
      [addrId],
    );
    let done = false;
    return {
      release: async () => {
        if (done) return;
        done = true;
        await holder.query('COMMIT');
        await holder.end();
      },
      abort: async () => {
        if (done) return;
        done = true;
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end().catch(() => undefined);
      },
    };
  }

  /** What an anonymized account must have: nothing of the person. */
  async function leftovers(id: string) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const cnt = async (t: string, col = 'customerId') =>
      Number(
        (
          await sql(
            `SELECT count(*)::int AS n FROM "${t}" WHERE "${col}" = $1::uuid`,
            [id],
          )
        )[0].n,
      );
    return {
      anonymized: c.anonymizedAt !== null,
      name: c.name,
      phone: c.phone,
      emailVerified: c.emailVerified,
      addresses: await cnt('Customer_Addresses'),
      carts: await cnt('Carts'),
      wishlists: await cnt('Wishlists'),
      sessions: await cnt('Customer_Sessions', 'userId'),
      accounts: await cnt('Customer_Accounts', 'userId'),
      verifications: Number(
        (
          await sql(
            `SELECT count(*)::int AS n FROM "Customer_Verifications" WHERE "value" = $1`,
            [id],
          )
        )[0].n,
      ),
      // consents are evidence (kept): only counted by the caller when it needs them
    };
  }
  const CLEAN = {
    anonymized: true,
    name: 'Cuenta eliminada',
    phone: null,
    emailVerified: false,
    addresses: 0,
    carts: 0,
    wishlists: 0,
    sessions: 0,
    accounts: 0,
    verifications: 0,
  };

  /** Small deterministic PRNG so a failing round can be replayed with the same seed. */
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /**
   * One random round: `ops` requests of the account (random kinds, random offsets of 0-`spreadMs` ms)
   * in parallel with the anonymization (also at a random offset). Returns what came back; the caller
   * asserts the invariants (no 5xx, anonymize 200, only 200/201/401 for the account's requests, and
   * NOTHING of the person left).
   */
  async function randomRound(
    seed: number,
    ops = 5,
    spreadMs = 25,
  ): Promise<RoundResult> {
    const rnd = mulberry32(seed);
    const c = await mkCustomer('rnd');
    const pid = await mkProduct(50);
    const jar = { Cookie: c.cookie };
    const kinds: Record<string, () => Promise<request.Response>> = {
      patchMe: () =>
        server()
          .patch(`${BASE}/auth/me`)
          .set(jar)
          .send({ name: 'Nombre Real', phone: '04149998877' })
          .then((r) => r),
      postAddress: () =>
        server()
          .post(`${BASE}/auth/addresses`)
          .set(jar)
          .send({
            agencyId: agency.id,
            deliveryMode: 'home_delivery',
            recipientName: 'Maria Perez',
            recipientPhone: '+58 (412) 123-4567',
            recipientIdDoc: 'v91234567',
            state: 'Miranda',
            municipality: 'Baruta',
            addressLine1: 'Calle 1, Casa 2',
          })
          .then((r) => r),
      patchAddress: () =>
        server()
          .patch(`${BASE}/auth/addresses/${c.addrId}`)
          .set(jar)
          .send({ label: 'Casa' })
          .then((r) => r),
      postCart: () =>
        server()
          .post(`${BASE}/cart/items`)
          .set(jar)
          .send({ productId: pid, quantity: 1 })
          .then((r) => r),
      postWishlist: () =>
        server()
          .post(`${BASE}/wishlist/items`)
          .set(jar)
          .send({ productId: pid })
          .then((r) => r),
      consent: () =>
        server()
          .post(`${BASE}/me/consent`)
          .set(jar)
          .send({})
          .then((r) => r),
    };
    const names = Object.keys(kinds);
    const picked = Array.from(
      { length: ops },
      () => names[Math.floor(rnd() * names.length)],
    );
    const later = <T>(ms: number, fn: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          fn().then(resolve, reject);
        }, ms);
      });
    const [anon, ...results] = await Promise.all([
      later(Math.floor(rnd() * spreadMs), () => anonymize(c.id, c.email)),
      ...picked.map((k) =>
        later(Math.floor(rnd() * spreadMs), () => kinds[k]()).then((r) => ({
          kind: k,
          status: r.status,
          body: r.body as Record<string, unknown>,
        })),
      ),
    ]);
    return {
      c,
      anon: { status: anon.status, body: anon.body as Record<string, unknown> },
      results,
      left: await leftovers(c.id),
    };
  }

  async function close() {
    const ids = customerIds;
    await prisma.order
      .deleteMany({ where: { customerId: { in: ids } } })
      .catch(() => undefined);
    await prisma.cart
      .deleteMany({
        where: {
          OR: [
            { customerId: { in: ids } },
            { id: { in: guestCartIds } },
            { items: { some: { productId: { in: productIds } } } },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.wishlist
      .deleteMany({
        where: {
          OR: [{ customerId: { in: ids } }, { id: { in: guestWishlistIds } }],
        },
      })
      .catch(() => undefined);
    await prisma.customerVerification
      .deleteMany({ where: { value: { in: ids } } })
      .catch(() => undefined);
    await prisma.customer
      .deleteMany({ where: { id: { in: ids } } })
      .catch(() => undefined);
    await prisma.product
      .deleteMany({ where: { id: { in: productIds } } })
      .catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { id: admin.id } })
      .catch(() => undefined);
    await app.close();
  }

  return {
    app,
    prisma,
    server,
    auth,
    sql,
    adminId: admin.id,
    mkCustomer,
    mkProduct,
    mkGuestCart,
    mkGuestWishlist,
    anonymize,
    waitBlocked,
    holdAddress,
    leftovers,
    randomRound,
    CLEAN,
    agencyId: agency.id,
    close,
    newId: randomUUID,
  };
}
export type Harness = Awaited<ReturnType<typeof bootHarness>>;
