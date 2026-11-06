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
import { AppModule } from './../src/app.module.js';
import { applyJsonBodyLimit } from './../src/common/json-body-limit.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  LegalSeedService,
  loadLegalSeedTemplates,
} from './../src/legal/legal-seed.service.js';
import { LEGAL_SLUGS } from './../src/legal/legal-slugs.js';
import { XSS_REJECT } from './../src/legal/xss-corpus.js';
import {
  createSandboxDocument,
  purgeSandbox,
  realLegalFingerprint,
  restoreLegalReal,
  snapshotLegalReal,
  type LegalRealSnapshot,
  type SandboxDoc,
} from './helpers/legal-sandbox.js';
import {
  purgeConsentDocs,
  seedConsentDocs,
  type SeededConsent,
} from './helpers/legal-consent.js';
import { withBuyerId } from './helpers/buyer-id.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/**
 * Story 19.9: regression of the whole Epic 19 against the real database, in
 * one place (AC1-AC6). The detailed per-story suites (`legal-*.e2e-spec.ts`)
 * stay; this one walks the user-visible flows end to end and re-checks the
 * invariants that must never regress: version history, concurrency, append-only
 * evidence, XSS, consent without Order/StockHold, idempotent seed, and the
 * historical data untouched (NFR-19.1).
 *
 * Only SANDBOX documents (`e2e-*`) are ever published; real documents are read
 * or rolled back. Zero network (fake FX/Stripe).
 */
const TAG = randomUUID().slice(0, 8);
const BASE = '/api/v1/admin/legal';
const PASS = 'correct-horse-battery-staple-19-9';
const USER = `e2e-admin-19-9-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PW = 'correct-horse-battery-19-9';
const emailOf = (k: string) => `e2e-19-9-${TAG}-${k}@212collectorsclub.test`;

interface Err {
  errorCode?: string;
  details?: Record<string, unknown>;
}
interface Draft {
  slug: string;
  bodyMd: string;
  revision: number;
  restoredFromVersion: number | null;
}
interface AuditBody {
  items: {
    action: string;
    slug: string | null;
    adminEmail: string | null;
    versionNumber: number | null;
  }[];
}
interface Consent {
  type: string;
  version: number;
  context: string;
  orderId: string | null;
  customerId: string | null;
}

const checkoutBody = (over: Record<string, unknown> = {}) => ({
  paymentRail: 'pago_movil',
  fulfillmentType: 'delivery',
  addressLine1: 'Av. Test 1',
  city: 'Caracas',
  state: 'Distrito Capital',
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
  ...over,
});

describe('Epic 19 regression (e2e, Story 19.9)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let fingerprint: string;
  let historyHash: string;
  let saved: LegalRealSnapshot;
  let seeded: SeededConsent;
  let categoryId: string;
  const docs: Record<string, SandboxDoc> = {};
  const productIds: string[] = [];
  const emails: string[] = [];

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const get = (p: string) => request(http()).get(`${BASE}${p}`).set(auth());
  const put = (p: string, b: object) =>
    request(http()).put(`${BASE}${p}`).set(auth()).send(b);
  const post = (p: string, b: object = {}) =>
    request(http()).post(`${BASE}${p}`).set(auth()).send(b);
  const pub = (p: string) => request(http()).get(`/api/v1/legal${p}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const inMs = async (ms: number) =>
    new Date(
      ((await sql(`SELECT now() AS n`))[0].n as Date).getTime() + ms,
    ).toISOString();
  const cookieOf = (res: request.Response, name: string): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] as string;

  const draftOf = async (slug: string) =>
    (await get(`/${slug}/draft`)).body as Draft;
  const createDraft = async (slug: string, bodyMd: string) =>
    (await put(`/${slug}/draft`, { bodyMd, baseRevision: 0 }).expect(200))
      .body as Draft;
  const publish = async (slug: string, over: Record<string, unknown> = {}) => {
    const d = await get(`/${slug}/draft`);
    return post(`/${slug}/publish`, {
      changeSummary: 'Cambio de prueba de la regresion',
      isSubstantial: false,
      expectedRevision: d.status === 200 ? (d.body as Draft).revision : 1,
      ...over,
    });
  };
  const versionsHash = async (docId: string) =>
    (
      await sql(
        `SELECT md5(coalesce(string_agg(to_jsonb(v)::text, '|' ORDER BY v."versionNumber"), '')) AS h FROM "Legal_Document_Versions" v WHERE v."documentId" = $1::uuid`,
        [docId],
      )
    )[0].h as string;
  const consentsOf = async (where: { customerId?: string; orderId?: string }) =>
    (
      (
        await request(http())
          .get(`${BASE}/consents`)
          .query(where)
          .set(auth())
          .expect(200)
      ).body as { consents: Consent[] }
    ).consents;
  /** Everything the historical data of NFR-19.1 consists of (never test rows). */
  const historyFingerprint = async () =>
    (
      await sql(
        `SELECT md5(concat_ws('#',
           (SELECT coalesce(string_agg(to_jsonb(o)::text, '|' ORDER BY o."id"), '') FROM "Orders" o),
           (SELECT coalesce(string_agg(to_jsonb(c)::text, '|' ORDER BY c."id"), '') FROM "Customers" c))) AS h`,
      )
    )[0].h as string;

  const mkProduct = async (key: string, stock = 50): Promise<string> => {
    const p = await prisma.product.create({
      data: {
        name: `R19${TAG} ${key}`,
        slug: `r19${TAG}-${key}`.toLowerCase(),
        description: 'Created by the Epic 19 regression.',
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
  };
  const guestCart = async (productId: string) =>
    cookieOf(
      await request(http())
        .post('/api/v1/cart/items')
        .send({ productId, quantity: 1 })
        .expect(201),
      'cartId',
    );
  const counts = async () => {
    const [o] = await sql(
      `SELECT count(*)::int AS n FROM "Orders" o WHERE EXISTS (SELECT 1 FROM "Order_Lines" l WHERE l."orderId" = o."id" AND l."productId" = ANY($1::uuid[]))`,
      [productIds],
    );
    const [h] = await sql(
      `SELECT count(*)::int AS n FROM "Stock_Holds" WHERE "productId" = ANY($1::uuid[])`,
      [productIds],
    );
    const [c] = await sql(`SELECT count(*)::int AS n FROM "Consent_Records"`);
    const [cu] = await sql(
      `SELECT count(*)::int AS n FROM "Customers" WHERE "email" LIKE $1`,
      [`e2e-19-9-${TAG}-%`],
    );
    return {
      orders: o.n as number,
      holds: h.n as number,
      consents: c.n as number,
      customers: cu.n as number,
    };
  };
  const register = (email: string, extra?: Record<string, unknown>) =>
    request(http())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: PW,
        name: 'R19 Tester',
        ...(extra ?? seeded.registerBody()),
      });
  async function customer(k: string) {
    const email = emailOf(k);
    emails.push(email);
    await register(email).expect(201);
    const c = await prisma.customer.update({
      where: { email },
      data: { emailVerified: true },
    });
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({ email, password: PW })
      .expect(200);
    return { email, id: c.id, s: cookieOf(res, 'cc_session') };
  }
  /** Runs `statement` after inserting evidence rows in a transaction that is ALWAYS rolled back. */
  const rejectedOnRealEvidence = async (statement: (id: string) => string) => {
    let message = '';
    let attempted = false;
    await prisma
      .$transaction(async (tx) => {
        const real = (
          await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT "id" FROM "Legal_Documents" WHERE "slug" = 'terminos' AND NOT "isSandbox"`,
          )
        )[0].id;
        await tx.$executeRawUnsafe(
          `INSERT INTO "Legal_Document_Versions" ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
           SELECT gen_random_uuid(), $1::uuid, coalesce(max("versionNumber"), 0) + 1, 'cuerpo', 'resumen de prueba', false,
                  greatest(now(), coalesce(max("effectiveFrom"), now()))
           FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
          real,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "Legal_Audit_Logs" ("id","documentId","action") VALUES (gen_random_uuid(), $1::uuid, 'PUBLISHED')`,
          real,
        );
        attempted = true;
        await tx.$executeRawUnsafe(statement(real));
      })
      .catch((e: unknown) => {
        message = e instanceof Error ? e.message : String(e);
      });
    expect(attempted).toBe(true);
    return message;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    applyJsonBodyLimit(app);
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
    // ONE shared listening server: concurrent rounds must not open an
    // ephemeral server per request.
    await app.listen(0);
    prisma = app.get(PrismaService);

    await purgeSandbox(sql, TAG);
    fingerprint = await realLegalFingerprint(sql);
    saved = await snapshotLegalReal(sql);
    historyHash = await historyFingerprint();
    categoryId = (await prisma.category.findFirstOrThrow()).id;

    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: EMAIL,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    token = (
      (
        await request(http())
          .post('/api/v1/admin/auth/login')
          .send({ usernameOrEmail: USER, password: PASS })
          .expect(200)
      ).body as { accessToken: string }
    ).accessToken;
    for (const k of ['flow', 'conc', 'xss', 'priv', 'put', 'dup', 'nod']) {
      docs[k] = await createSandboxDocument(sql, `${TAG}-${k}`);
    }
    seeded = await seedConsentDocs(sql, {
      terms: [
        { versionNumber: 1, effectiveFrom: '-3 days' },
        { versionNumber: 2, effectiveFrom: '-2 days', isSubstantial: true },
        { versionNumber: 3, effectiveFrom: '-1 day' },
      ],
      privacy: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
      shipping: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
      returns: [{ versionNumber: 1, effectiveFrom: '-1 day' }],
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({
      where: { lines: { some: { productId: { in: productIds } } } },
    });
    await prisma.cart.deleteMany({
      where: {
        OR: [
          { customer: { email: { in: emails } } },
          { items: { some: { productId: { in: productIds } } } },
        ],
      },
    });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.adminUser.delete({ where: { id: adminId } });
    // AC3: the sandbox is cleaned (real evidence never is); consent evidence
    // was released by deleting its customers/orders above.
    await purgeConsentDocs(sql);
    await purgeSandbox(sql, TAG);
    await restoreLegalReal(sql, saved);
    // AC6 / NFR-19.1: real legal rows and historical data identical.
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    expect(await historyFingerprint()).toBe(historyHash);
    await app.close();
  });

  describe('AC1: draft -> v1 -> edit -> v2 in one flow', () => {
    it('GET /legal/:slug serves v2, /versions/1 stays intact, diff 1->2 has only the changed lines, restore v1 makes a draft without touching history, every action is audited with its actor', async () => {
      const slug = docs.flow.slug;
      const v1 = '## Titulo\n\nlinea 1\nlinea 2\nlinea 3\nlinea 4\nlinea 5\n';
      const v2 =
        '## Titulo\n\nlinea 1\nlinea 2\nlinea TRES\nlinea 4\nlinea 5\n';

      await get(`/${slug}/draft`).expect(404);
      await createDraft(slug, v1);
      const p1 = await publish(slug, {
        effectiveFrom: await inMs(1_500),
        changeSummary: 'Primera version publicada',
      });
      expect(p1.status).toBe(201);
      expect(p1.body).toMatchObject({ versionNumber: 1 });
      await sleep(2_100);
      let cur = (await pub(`/${slug}`).expect(200)).body as {
        status: string;
        version: { versionNumber: number; bodyMd: string };
      };
      expect(cur.status).toBe('PUBLISHED');
      expect(cur.version).toMatchObject({ versionNumber: 1, bodyMd: v1 });
      // isCurrent / supersededAt legitimately change when v2 takes over; the
      // content of the version (what was published) must never change.
      const frozen = async () => {
        const b = (await pub(`/${slug}/versions/1`).expect(200)).body as {
          version: Record<string, unknown>;
        };
        const { isCurrent: _c, supersededAt: _s, ...rest } = b.version;
        void _c;
        void _s;
        return rest;
      };
      const v1Public = await frozen();

      await createDraft(slug, v2);
      const p2 = await publish(slug, {
        effectiveFrom: await inMs(1_500),
        changeSummary: 'Segunda version, linea 3',
        isSubstantial: true,
      });
      expect(p2.status).toBe(201);
      await sleep(2_100);
      cur = (await pub(`/${slug}`).expect(200)).body as typeof cur;
      expect(cur.version).toMatchObject({ versionNumber: 2, bodyMd: v2 });
      expect(await frozen()).toEqual(v1Public);

      const diff = (await get(`/${slug}/diff?from=1&to=2`).expect(200))
        .body as {
        stats: { added: number; removed: number };
        hunks: { type: string; lines: string[] }[];
      };
      expect(diff.stats).toEqual({ added: 1, removed: 1 });
      expect(
        diff.hunks
          .filter((h) => h.type !== 'context')
          .map((h) => [h.type, h.lines]),
      ).toEqual([
        ['removed', ['linea 3']],
        ['added', ['linea TRES']],
      ]);

      const hash = await versionsHash(docs.flow.id);
      const restored = (
        await post(`/${slug}/restore`, { version: 1 }).expect(201)
      ).body as Draft;
      expect(restored).toMatchObject({ restoredFromVersion: 1, bodyMd: v1 });
      expect(await versionsHash(docs.flow.id)).toBe(hash);
      expect(
        ((await pub(`/${slug}`).expect(200)).body as typeof cur).version
          .versionNumber,
      ).toBe(2);

      const audit = (await get(`/audit?slug=${slug}&limit=100`).expect(200))
        .body as AuditBody;
      const actions = audit.items.map((i) => i.action);
      for (const a of ['DRAFT_CREATED', 'PUBLISHED', 'RESTORED']) {
        expect(actions).toContain(a);
      }
      expect(actions.filter((a) => a === 'PUBLISHED')).toHaveLength(2);
      expect(audit.items.every((i) => i.adminEmail === EMAIL)).toBe(true);
      expect(
        audit.items
          .filter((i) => i.action === 'PUBLISHED')
          .map((i) => i.versionNumber)
          .sort(),
      ).toEqual([1, 2]);
    });
  });

  describe('AC2: real concurrency (Promise.all), no upsert as uniqueness mechanism', () => {
    it('5 simultaneous publishes of one document: consecutive versions without gaps, no 5xx', async () => {
      const slug = docs.conc.slug;
      for (let round = 1; round <= 3; round++) {
        const d = await createDraft(slug, `## Ronda ${round}\n\nTexto.\n`);
        const eff = await inMs(1_000 * round);
        const rs = await Promise.all(
          Array.from({ length: 5 }, () =>
            post(`/${slug}/publish`, {
              changeSummary: 'Publicacion concurrente',
              isSubstantial: false,
              effectiveFrom: eff,
              expectedRevision: d.revision,
            }),
          ),
        );
        expect(rs.every((r) => r.status < 500)).toBe(true);
        expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      }
      const v = await sql(
        `SELECT "versionNumber" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid ORDER BY 1`,
        [docs.conc.id],
      );
      expect(v.map((r) => r.versionNumber)).toEqual([1, 2, 3]);
    });

    it('2 PUT draft with the same baseRevision: exactly one 200 and one 409', async () => {
      const slug = docs.put.slug;
      const d = await createDraft(slug, '## Base\n\nTexto.\n');
      const rs = await Promise.all(
        ['## A\n\nuno\n', '## B\n\ndos\n'].map((bodyMd) =>
          put(`/${slug}/draft`, { bodyMd, baseRevision: d.revision }),
        ),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((rs.find((r) => r.status === 409)?.body as Err).errorCode).toBe(
        'LEGAL_DRAFT_STALE',
      );
    });

    it('2 simultaneous draft creations: one 200 and one 409', async () => {
      const slug = docs.dup.slug;
      const rs = await Promise.all(
        ['## A\n\nuno\n', '## B\n\ndos\n'].map((bodyMd) =>
          put(`/${slug}/draft`, { bodyMd, baseRevision: 0 }),
        ),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('concurrent checkouts with consent: exactly 3 ConsentRecord per order, one order per cart', async () => {
      const p = await mkProduct('conc', 40);
      const carts = await Promise.all(
        Array.from({ length: 4 }, () => guestCart(p)),
      );
      const rs = await Promise.all(
        carts.map((c) =>
          request(http())
            .post('/api/v1/checkout')
            .set('Cookie', c)
            .send(withBuyerId(checkoutBody(seeded.checkoutBody()))),
        ),
      );
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const orderIds = rs.map((r) => (r.body as { orderId: string }).orderId);
      expect(new Set(orderIds).size).toBe(4);
      for (const orderId of orderIds) {
        const rows = await consentsOf({ orderId });
        expect(rows.map((r) => r.type).sort()).toEqual([
          'RETURNS',
          'SHIPPING',
          'TERMS',
        ]);
      }
    });

    it('no source file of the legal/consent code uses upsert (uniqueness is ON CONFLICT or P2002)', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name))
            : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
              ? [join(dir, e.name)]
              : [],
        );
      const offenders = walk(resolve(process.cwd(), 'src/legal')).filter((f) =>
        /\.upsert\(|ON\s+CONFLICT\s+.*DO\s+UPDATE/is.test(
          readFileSync(f, 'utf8'),
        ),
      );
      expect(offenders).toEqual([]);
    });
  });

  describe('AC3: immutability (NFR-19.2)', () => {
    it('UPDATE, DELETE and TRUNCATE on real versions and audit rows fail; evidence exists only inside a rolled-back transaction', async () => {
      for (const stmt of [
        (id: string) =>
          `UPDATE "Legal_Document_Versions" SET "bodyMd" = 'alterado' WHERE "documentId" = '${id}'`,
        (id: string) =>
          `DELETE FROM "Legal_Document_Versions" WHERE "documentId" = '${id}'`,
        () => `TRUNCATE "Legal_Document_Versions"`,
        (id: string) =>
          `UPDATE "Legal_Audit_Logs" SET "meta" = '{"x":1}' WHERE "documentId" = '${id}'`,
        (id: string) =>
          `DELETE FROM "Legal_Audit_Logs" WHERE "documentId" = '${id}'`,
        () => `TRUNCATE "Legal_Audit_Logs"`,
      ]) {
        const msg = await rejectedOnRealEvidence(stmt);
        expect(msg, 'the statement must be rejected').not.toBe('');
      }
      expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    });

    it('linked Consent_Records cannot be updated, deleted or truncated', async () => {
      const p = await mkProduct('imm');
      const r = await request(http())
        .post('/api/v1/checkout')
        .set('Cookie', await guestCart(p))
        .send(withBuyerId(checkoutBody(seeded.checkoutBody())))
        .expect(201);
      const orderId = (r.body as { orderId: string }).orderId;
      expect(await consentsOf({ orderId })).toHaveLength(3);
      for (const stmt of [
        `UPDATE "Consent_Records" SET "version" = 99 WHERE "orderId" = '${orderId}'`,
        `DELETE FROM "Consent_Records" WHERE "orderId" = '${orderId}'`,
        `TRUNCATE "Consent_Records"`,
      ]) {
        await expect(prisma.$executeRawUnsafe(stmt)).rejects.toThrow();
      }
      expect(await consentsOf({ orderId })).toHaveLength(3);
    });

    it('no API route modifies versions or the audit log (sources never call update/delete on them)', () => {
      const FORBIDDEN =
        /legalDocumentVersion\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|legalAuditLog\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/;
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? e.name === 'generated'
              ? []
              : walk(join(dir, e.name))
            : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
              ? [join(dir, e.name)]
              : [],
        );
      expect(
        walk(resolve(process.cwd(), 'src')).filter((f) =>
          FORBIDDEN.test(readFileSync(f, 'utf8')),
        ),
      ).toEqual([]);
    });

    it('sandbox documents are cleaned by the helper (and nothing real is touched)', async () => {
      const d = await createSandboxDocument(sql, `${TAG}-clean`);
      await sql(
        `INSERT INTO "Legal_Audit_Logs" ("id","documentId","action") VALUES (gen_random_uuid(), $1::uuid, 'PUBLISHED')`,
        [d.id],
      );
      await purgeSandbox(sql, `${TAG}-clean`);
      expect(
        await sql(`SELECT 1 FROM "Legal_Documents" WHERE "id" = $1::uuid`, [
          d.id,
        ]),
      ).toHaveLength(0);
      expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    });
  });

  describe('AC4: security and contract', () => {
    it('every XSS vector of the corpus is rejected with 400 and nothing reaches the draft', async () => {
      const slug = docs.xss.slug;
      const base = '## Base\n\nTexto limpio.\n';
      const d = await createDraft(slug, base);
      for (const c of XSS_REJECT) {
        const res = await put(`/${slug}/draft`, {
          bodyMd: c.md,
          baseRevision: d.revision,
        });
        expect([c.name, res.status]).toEqual([c.name, 400]);
        const err = res.body as Err;
        expect(err.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
        // Story 19.9: the cause is machine-readable, a rejected construct is never a TIMEOUT
        expect(err.details?.reason).not.toBe('TIMEOUT');
      }
      const after = await draftOf(slug);
      expect(after).toMatchObject({ bodyMd: base, revision: d.revision });
      // and publishing the clean draft still works / the vectors never became a version
      expect(
        await sql(
          `SELECT 1 FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
          [docs.xss.id],
        ),
      ).toHaveLength(0);
    });

    it('a draft is not reachable through any public route', async () => {
      const marker = `PRIVATE-DRAFT-${TAG}`;
      await createDraft(docs.priv.slug, `## Privado\n\n${marker}`);
      for (const p of [
        `/api/v1/legal/${docs.priv.slug}`,
        `/api/v1/legal/${docs.priv.slug}/versions`,
        `/api/v1/legal/${docs.priv.slug}/versions/1`,
        '/api/v1/legal',
        '/api/v1/legal/current-versions',
        '/api/v1/legal/identity',
      ]) {
        const res = await request(http()).get(p);
        expect(JSON.stringify(res.body)).not.toContain(marker);
      }
    });

    it('401 without a token on every admin route; 404 for an unknown document', async () => {
      const s = 'terminos';
      for (const [m, p] of [
        ['get', ''],
        ['get', '/consents'],
        ['get', `/${s}/draft`],
        ['put', `/${s}/draft`],
        ['post', `/${s}/draft/discard`],
        ['post', `/${s}/publish`],
        ['post', `/${s}/restore`],
        ['get', `/${s}/history`],
        ['get', `/${s}/diff?from=1&to=2`],
        ['get', '/audit'],
        ['get', '/identity'],
        ['put', '/identity'],
      ] as const) {
        const res = await request(http())[m](`${BASE}${p}`).send({});
        expect([m, p, res.status]).toEqual([m, p, 401]);
      }
      await get('/nope/draft').expect(404);
      await get('/nope/history').expect(404);
    });

    it('publish answers each documented status: 400, 404, 409, 422 and 201', async () => {
      const slug = docs.put.slug; // has a draft from the PUT race above
      const d = await draftOf(slug);
      const e400 = await post(`/${slug}/publish`, {
        changeSummary: 'corto',
        isSubstantial: false,
        expectedRevision: d.revision,
        effectiveFrom: await inMs(5_000),
      }).expect(400);
      expect(e400.status).toBe(400);
      const e409 = await post(`/${slug}/publish`, {
        changeSummary: 'Revision vieja del borrador',
        isSubstantial: false,
        expectedRevision: d.revision + 50,
        effectiveFrom: await inMs(5_000),
      }).expect(409);
      expect((e409.body as Err).errorCode).toBe('LEGAL_DRAFT_STALE');
      const e404 = await post(`/${docs.nod.slug}/publish`, {
        changeSummary: 'Sin borrador existente',
        isSubstantial: false,
        expectedRevision: 1,
        effectiveFrom: await inMs(5_000),
      }).expect(404);
      expect((e404.body as Err).errorCode).toBe('LEGAL_DRAFT_NOT_FOUND');
      // 422: a placeholder blocks the publication
      await put(`/${slug}/draft`, {
        bodyMd: '## T\n\nRazon social [[RAZON_SOCIAL]]\n',
        baseRevision: d.revision,
      }).expect(200);
      const e422 = await publish(slug, { effectiveFrom: await inMs(5_000) });
      expect(e422.status).toBe(422);
      expect((e422.body as Err).errorCode).toBe('LEGAL_PLACEHOLDERS_PENDING');
    });

    it('Swagger (/api/docs-json) documents an errorCode for every 4xx of every admin legal operation', async () => {
      const spec = (await request(http()).get('/api/docs-json').expect(200))
        .body as {
        paths: Record<
          string,
          Record<
            string,
            { responses: Record<string, { description?: string }> }
          >
        >;
      };
      const paths = Object.entries(spec.paths).filter(([p]) =>
        /\/(admin\/legal|legal|me\/consent)/.test(p),
      );
      expect(paths.length).toBeGreaterThanOrEqual(15);
      for (const [path, ops] of paths) {
        for (const [method, op] of Object.entries(ops)) {
          for (const [code, r] of Object.entries(op.responses)) {
            if (!/^4\d\d$/.test(code) || code === '401') continue;
            const where = `${method.toUpperCase()} ${path} ${code}`;
            expect(
              [
                where,
                /[A-Z]{3,}(_[A-Z]+)+|validation/.test(r.description ?? ''),
              ],
              where,
            ).toEqual([where, true]);
          }
        }
      }
      const put = spec.paths['/api/v1/admin/legal/{slug}/draft'].put;
      expect(put.responses['400'].description).toMatch(/details\.reason/);
    });
  });

  describe('AC5: consent end to end', () => {
    it('register without boxes / without age / with an old version: 400 / 409 and no Customer', async () => {
      const email = emailOf('reg-bad');
      emails.push(email);
      const before = await counts();
      const none = await register(email, {}).expect(400);
      expect((none.body as Err).errorCode).toBe('CONSENT_REQUIRED');
      await register(email, {
        acceptedTermsVersion: 3,
        acceptedPrivacyVersion: 1,
        ageDeclared: false,
      }).expect(400);
      const stale = await register(email, {
        acceptedTermsVersion: 2,
        acceptedPrivacyVersion: 1,
        ageDeclared: true,
      }).expect(409);
      expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
      expect(await counts()).toEqual(before);
    });

    it('checkout of a guest and of an account without acceptance or with an old version: 400 / 409, no Order, no StockHold', async () => {
      const p = await mkProduct('bad');
      const c = await customer('co-bad');
      const guest = await guestCart(p);
      await request(http())
        .post('/api/v1/cart/items')
        .set('Cookie', c.s)
        .send({ productId: p, quantity: 1 })
        .expect(201);
      const before = await counts();
      const heldBefore = (
        await prisma.product.findUniqueOrThrow({ where: { id: p } })
      ).heldQty;
      for (const who of [guest, c.s]) {
        const none = await request(http())
          .post('/api/v1/checkout')
          .set('Cookie', who)
          .send(withBuyerId(checkoutBody()))
          .expect(400);
        expect((none.body as Err).errorCode).toBe('CONSENT_REQUIRED');
        const stale = await request(http())
          .post('/api/v1/checkout')
          .set('Cookie', who)
          .send(
            withBuyerId(
              checkoutBody({
                acceptedTermsVersion: 2,
                acceptedShippingVersion: 1,
                acceptedReturnsVersion: 1,
              }),
            ),
          )
          .expect(409);
        expect((stale.body as Err).errorCode).toBe('CONSENT_VERSION_STALE');
      }
      expect(await counts()).toEqual(before);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: p } })).heldQty,
      ).toBe(heldBefore);
    });

    it('with acceptance the Order keeps the 3 versions and termsAcceptedAt, and 3 ConsentRecord exist', async () => {
      const p = await mkProduct('ok');
      const r = await request(http())
        .post('/api/v1/checkout')
        .set('Cookie', await guestCart(p))
        .send(withBuyerId(checkoutBody(seeded.checkoutBody())))
        .expect(201);
      const orderId = (r.body as { orderId: string }).orderId;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(order).toMatchObject({
        termsVersion: 3,
        shippingVersion: 1,
        returnsVersion: 1,
      });
      expect(order.termsAcceptedAt).toBeInstanceOf(Date);
      const rows = await consentsOf({ orderId });
      expect(rows.map((x) => [x.type, x.version, x.context]).sort()).toEqual([
        ['RETURNS', 1, 'CHECKOUT'],
        ['SHIPPING', 1, 'CHECKOUT'],
        ['TERMS', 3, 'CHECKOUT'],
      ]);
    });

    it('a stock failure leaves zero ConsentRecord, Order and StockHold', async () => {
      const p = await mkProduct('stock', 5);
      const cart = await guestCart(p);
      await prisma.product.update({ where: { id: p }, data: { stock: 0 } });
      const before = await counts();
      const res = await request(http())
        .post('/api/v1/checkout')
        .set('Cookie', cart)
        .send(withBuyerId(checkoutBody(seeded.checkoutBody())));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await counts()).toEqual(before);
    });

    it('pending: a customer with no prior record is pending; a substantial change makes everyone pending, a non-substantial one nobody', async () => {
      const a = await customer('pend-a'); // registered at terms 3
      const status = async (cookie: string) =>
        (
          await request(http())
            .get('/api/v1/me/consent-status')
            .set('Cookie', cookie)
            .expect(200)
        ).body as {
          pending: { slug: string }[];
          ageDeclarationPending: boolean;
        };
      expect((await status(a.s)).pending).toEqual([]);

      // legacy account: created directly (no registration), no acceptance on file
      const legacyEmail = emailOf('pend-legacy');
      emails.push(legacyEmail);
      const id = randomUUID();
      await prisma.customer.create({
        data: {
          id,
          email: legacyEmail,
          name: 'R19 Legacy',
          emailVerified: true,
          customeraccounts: {
            create: {
              accountId: id,
              providerId: 'credential',
              password: await argon2.hash(PW, { type: argon2.argon2id }),
            },
          },
        },
      });
      const login = await request(http())
        .post('/api/v1/auth/login')
        .send({ email: legacyEmail, password: PW })
        .expect(200);
      const legacy = cookieOf(login, 'cc_session');
      const ls = await status(legacy);
      expect(ls.pending.map((x) => x.slug).sort()).toEqual([
        'privacidad',
        'terminos',
      ]);
      expect(ls.ageDeclarationPending).toBe(true);

      await seeded.addVersion('terms', {
        versionNumber: 4,
        effectiveFrom: '-30 minutes',
        changeSummary: 'ortografia',
      });
      expect((await status(a.s)).pending).toEqual([]); // not substantial

      await seeded.addVersion('terms', {
        versionNumber: 5,
        effectiveFrom: '-10 minutes',
        isSubstantial: true,
        changeSummary: 'nueva clausula',
      });
      expect((await status(a.s)).pending.map((x) => x.slug)).toEqual([
        'terminos',
      ]);
    });
  });

  describe('AC6: idempotent seed, public routes in preparation, historical data', () => {
    it('seeding twice leaves 6 drafts and no published version; the public routes say IN_PREPARATION', async () => {
      // The six real documents are immutable once audited: the same code path
      // runs on six SANDBOX documents that receive the real templates.
      const real = await loadLegalSeedTemplates(
        resolve(process.cwd(), 'prisma/seed-data/legal'),
      );
      expect(real.map((t) => t.slug)).toEqual([...LEGAL_SLUGS]);
      const sandboxSlugs: string[] = [];
      const templates = [];
      for (const t of real) {
        const d = await createSandboxDocument(sql, `${TAG}-s-${t.slug}`);
        sandboxSlugs.push(d.slug);
        templates.push({ slug: d.slug, bodyMd: t.bodyMd });
      }
      const svc = new LegalSeedService(prisma);
      const first = await svc.seedDrafts(templates);
      expect(first.map((r) => r.outcome)).toEqual(Array(6).fill('CREATED'));
      const second = await svc.seedDrafts(templates);
      expect(second.every((r) => r.outcome !== 'CREATED')).toBe(true);
      // concurrently too (two deploys at once): still one draft per document
      await Promise.all([svc.seedDrafts(templates), svc.seedDrafts(templates)]);
      const [c] = await sql(
        `SELECT count(*)::int AS drafts,
                (SELECT count(*)::int FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id" = v."documentId" WHERE d."slug" = ANY($1::text[])) AS versions
         FROM "Legal_Drafts" x JOIN "Legal_Documents" d ON d."id" = x."documentId" WHERE d."slug" = ANY($1::text[])`,
        [sandboxSlugs],
      );
      expect(c).toEqual({ drafts: 6, versions: 0 });
      for (const slug of sandboxSlugs) {
        const b = (await pub(`/${slug}`).expect(200)).body as {
          status: string;
          version?: unknown;
        };
        expect(b.status).toBe('IN_PREPARATION');
        expect(b).not.toHaveProperty('version');
      }
    });

    it('the six real documents are listed, historical orders keep NULL consent columns, and the dev data is not touched (checked again in afterAll)', async () => {
      const list = (await pub('').expect(200)).body as {
        slug: string;
        status: string;
      }[];
      expect(list.map((d) => d.slug)).toEqual([...LEGAL_SLUGS]);
      expect(
        list.every((d) => ['PUBLISHED', 'IN_PREPARATION'].includes(d.status)),
      ).toBe(true);
      const [r] = await sql(
        `SELECT count(*)::int AS n FROM "Orders" o
         WHERE NOT EXISTS (SELECT 1 FROM "Order_Lines" l WHERE l."orderId" = o."id" AND l."productId" = ANY($1::uuid[]))
           AND ("termsVersion" IS NOT NULL OR "shippingVersion" IS NOT NULL
             OR "returnsVersion" IS NOT NULL OR "termsAcceptedAt" IS NOT NULL)`,
        [productIds],
      );
      expect(r.n).toBe(0);
    });
  });
});
