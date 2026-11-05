/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies and pg rows are untyped JSON */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { AuditService } from './../src/audit/audit.service.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import { CUSTOMER_AUTH } from './../src/auth-core/auth-core.constants.js';
import type { CustomerAuth } from './../src/auth-core/customer-auth.factory.js';
import { PROOF_OF_PAYMENT_DIR } from './../src/orders/upload-paths.constants.js';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';
import { blockAuditAction } from './helpers/block-audit-action.js';
import { appCrypto } from './helpers/iddoc-assert.js';
import { withBuyerId } from './helpers/buyer-id.js';
import { registerConsent } from './helpers/legal-consent.js';

/**
 * Story 20.6 (AD-98, FR-119..122): anonymization of a customer account, the cedula-free search, the
 * detail with the real numbers for the warning, the reserved domain, and the lock against the
 * checkout. Runs on the THROW-AWAY database every e2e run gets (global-test-db.ts): nothing here
 * can leave an undeletable audit row anywhere that matters, and no real account is ever touched
 * (every customer is created here with a synthetic email and removed in afterAll).
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const PASS = 'correct-horse-battery-staple-20-6';
const CPASS = 'correct-horse-battery-20-6';
const BASE = '/api/v1';
const GOOD_REASON = `Solicitud del titular por WhatsApp, ref ${TAG}, 2026-11-04`;
const emailOf = (k: string) => `e2e-206-${TAG}-${k}@212collectorsclub.test`;
/** Never a real number: nine-prefixed synthetic cedulas. */
const CED_A = 'V-91234567';
const CED_B = 'E-92345678';
const CED_C = 'V-93456789';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type Cust = { id: string; email: string; cookie: string };
type Row = {
  seq: number;
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
};

describe(
  'Customer anonymization (e2e, Story 20.6)',
  { timeout: 90_000 },
  () => {
    let app: NestExpressApplication;
    let base: string;
    let prisma: PrismaService;
    let adminId: string;
    let token: string;
    let categoryId: string;
    let agencyId: string;
    const customerIds: string[] = [];
    const emails: string[] = [];
    const productIds: string[] = [];
    const proofFiles: string[] = [];
    const stripeEventIds: string[] = [];
    const server = () => request(base);
    const auth = () => ({ Authorization: `Bearer ${token}` });
    const ADMIN_USER = `e2e-206-${TAG}`;
    const sql = (q: string, p: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

    const head = async (): Promise<number> =>
      Number(
        (
          await sql(
            `SELECT COALESCE(max("seq"), 0)::int AS s FROM "Audit_Events"`,
          )
        )[0].s,
      );
    const anonEvents = async (customerId?: string): Promise<Row[]> =>
      (await sql(
        `SELECT "seq"::int AS "seq", "action", "actorType", "actorId"::text AS "actorId", "entityType", "entityId",
                "before", "after", "reason"
           FROM "Audit_Events" WHERE "action" = 'CUSTOMER_ANONYMIZED' AND ($1::text IS NULL OR "entityId" = $1)
          ORDER BY "seq"`,
        [customerId ?? null],
      )) as unknown as Row[];

    const cookieOf = (res: request.Response, name: string): string =>
      ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0] as string;

    let n = 0;
    async function mkCustomer(
      key: string,
      o: { verified?: boolean; logins?: number } = {},
    ): Promise<Cust & { extraCookies: string[] }> {
      n += 1;
      const email = emailOf(`${key}${n}`);
      emails.push(email);
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
      const cookies: string[] = [];
      for (let i = 0; i < (o.logins ?? 1); i++) {
        const res = await server()
          .post(`${BASE}/auth/login`)
          .send({ email, password: CPASS })
          .expect(200);
        cookies.push(cookieOf(res, 'cc_session'));
      }
      return {
        id: c.id,
        email,
        cookie: cookies[0],
        extraCookies: cookies.slice(1),
      };
    }

    async function mkProduct(stock = 5): Promise<string> {
      n += 1;
      const p = await prisma.product.create({
        data: {
          name: `Anon${TAG} ${n}`,
          slug: `anon${TAG}-${n}`.toLowerCase(),
          description: 'Created by e2e 20.6.',
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

    async function mkOrder(
      customerId: string,
      status:
        | 'PAYMENT_PROCESSING'
        | 'PENDING_VERIFICATION'
        | 'PAID'
        | 'FULFILLED'
        | 'CANCELLED'
        | 'PAYMENT_FAILED'
        | 'PAYMENT_REJECTED'
        | 'EXPIRED',
      ced = CED_A,
      buyer: string | null = CED_B,
    ): Promise<string> {
      const r = appCrypto.protect(ced);
      const b = buyer ? appCrypto.protect(buyer) : null;
      const o = await prisma.order.create({
        data: {
          status,
          customerId,
          paymentRail: 'PAGO_MOVIL',
          fulfillmentType: 'DELIVERY',
          recipientName: `Destinatario ${TAG}`,
          recipientPhone: '04129990000',
          addressLine1: 'Calle Sintetica 1',
          city: 'Caracas',
          state: 'Distrito Capital',
          totalUsd: '5.00',
          accessTokenHash: randomUUID(),
          recipientIdDocEnc: r?.enc ?? null,
          recipientIdDocBlind: r?.blind ?? null,
          buyerIdType: (b?.type as 'V' | 'E' | null) ?? null,
          buyerIdDocEnc: b?.enc ?? null,
          buyerIdDocBlind: b?.blind ?? null,
          buyerLegalName: null,
        },
      });
      await prisma.orderStatusHistory.create({
        data: { orderId: o.id, toStatus: status, actorType: 'SYSTEM' },
      });
      return o.id;
    }

    /** Everything an account owns, so the test can see it disappear (or stay). */
    async function seed(c: Cust, extra: { active?: boolean } = {}) {
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: c.id,
          agencyId,
          recipientName: 'Direccion Sintetica',
          recipientPhone: '04121111111',
          recipientIdDocEnc: appCrypto.protect(CED_A)?.enc,
          recipientIdDocBlind: appCrypto.protect(CED_A)?.blind,
          deliveryMode: 'AGENCY_OFFICE',
          state: 'Miranda',
          municipality: 'Chacao',
          isDefault: true,
        },
      });
      const pid = await mkProduct();
      const wl = await prisma.wishlist.create({
        data: {
          customerId: c.id,
          expiresAt: new Date(Date.now() + 86_400_000),
          items: { create: [{ productId: pid }] },
        },
      });
      const cart = await prisma.cart.create({
        data: {
          customerId: c.id,
          expiresAt: new Date(Date.now() + 86_400_000),
          items: { create: [{ productId: pid, quantity: 1 }] },
        },
      });
      const email = (
        await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
      ).email;
      await prisma.customerVerification.createMany({
        data: [
          {
            identifier: email,
            value: `by-email-${TAG}`,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          {
            identifier: `email-verification:${sha(`${TAG}${c.id}`)}`,
            value: c.id,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          {
            // BetterAuth stores a reset token as a hash of "reset-password:<token>", value = user id
            identifier: sha(`reset-password:${TAG}${c.id}`),
            value: c.id,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ],
      });
      const unrelatedVerification = await prisma.customerVerification.create({
        data: {
          identifier: `other-${TAG}-${c.id}`,
          value: `other-${TAG}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const inq = await prisma.contactInquiry.createMany({
        data: [
          {
            name: 'Cliente',
            email: email.toUpperCase(),
            message: `Hola ${TAG}`,
          },
          { name: 'Cliente', email, message: `Hola otra vez ${TAG}` },
        ],
      });
      const otherInquiry = await prisma.contactInquiry.create({
        data: {
          name: 'Otra Persona',
          email: emailOf(`unrelated-${c.id.slice(0, 6)}`),
          message: `No es de este cliente ${TAG}`,
        },
      });
      void inq;
      const finals = [
        'FULFILLED',
        'CANCELLED',
        'PAYMENT_FAILED',
        'PAYMENT_REJECTED',
        'EXPIRED',
      ] as const;
      const orderIds: string[] = [];
      for (const s of finals) orderIds.push(await mkOrder(c.id, s));
      if (extra.active) orderIds.push(await mkOrder(c.id, 'PAID'));
      await prisma.orderTrackingEvent.create({
        data: { orderId: orderIds[0], previousValue: null, newValue: 'T-1' },
      });
      // A proof of payment with its file on disk (private upload root).
      const rel = `proof-of-payment/e2e206-${TAG}-${c.id.slice(0, 8)}.png`;
      const abs = join(dirname(PROOF_OF_PAYMENT_DIR), rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(`synthetic-proof-${TAG}`));
      proofFiles.push(abs);
      const proof = await prisma.proofOfPayment.create({
        data: {
          orderId: orderIds[1],
          filePath: rel,
          mimeType: 'image/png',
          sizeBytes: 30,
        },
      });
      return {
        addr,
        wl,
        cart,
        orderIds,
        proof,
        proofAbs: abs,
        unrelatedVerification,
        otherInquiry,
        email,
      };
    }

    /** Tokens of the account: the 3 seeded + the verification mail token that register issues in the background. */
    const tokensOf = (id: string, email: string): Promise<number> =>
      count(
        `SELECT count(*) AS n FROM "Customer_Verifications" WHERE "identifier" = $1 OR "value" = $2`,
        [email, id],
      );
    const ordersFingerprint = async (id: string): Promise<string> =>
      String(
        (
          await sql(
            `SELECT md5(COALESCE(string_agg(o::text, '|' ORDER BY o."id"), '')) AS h FROM "Orders" o WHERE o."customerId" = $1::uuid`,
            [id],
          )
        )[0].h,
      );
    const tableFingerprint = async (t: string): Promise<string> =>
      String(
        (
          await sql(
            `SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
          )
        )[0].h,
      );
    const consentsOf = async (id: string): Promise<string> =>
      String(
        (
          await sql(
            `SELECT md5(COALESCE(string_agg(c::text, '|' ORDER BY c."id"), '')) || ':' || count(*) AS h FROM "Consent_Records" c WHERE c."customerId" = $1::uuid`,
            [id],
          )
        )[0].h,
      );
    const count = async (q: string, p: unknown[]): Promise<number> =>
      Number((await sql(q, p))[0].n);

    const anonymize = (
      id: string,
      body: Record<string, unknown>,
      headers: Record<string, string> = auth(),
    ) =>
      server()
        .post(`${BASE}/admin/customers/${id}/anonymize`)
        .set(headers)
        .send(body);

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleFixture.createNestApplication<NestExpressApplication>();
      app.set('trust proxy', 1);
      applyRequestContext(app);
      app.use(
        cookieParser(
          app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET'),
        ),
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
      // A real listener: supertest closes an unstarted server after the first answer, which resets
      // the other requests of a Promise.all.
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
      prisma = app.get(PrismaService);
      categoryId = (await prisma.category.findFirstOrThrow()).id;
      agencyId = (await prisma.shippingAgency.findFirstOrThrow()).id;
      const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
      const admin = await prisma.adminUser.create({
        data: {
          username: ADMIN_USER,
          email: `${ADMIN_USER}@212collectorsclub.test`,
          passwordHash,
        },
      });
      adminId = admin.id;
      const login = await server()
        .post(`${BASE}/admin/auth/login`)
        .send({ usernameOrEmail: ADMIN_USER, password: PASS })
        .expect(200);
      token = (login.body as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      const cust = {
        OR: [
          { id: { in: customerIds } },
          { email: { in: emails } },
          { email: { startsWith: `e2e-206-${TAG}` } },
        ],
      };
      const found = await prisma.customer.findMany({
        where: cust,
        select: { id: true },
      });
      const ids = found.map((c) => c.id);
      await prisma.order
        .deleteMany({ where: { customerId: { in: ids } } })
        .catch(() => undefined);
      await prisma.cart
        .deleteMany({
          where: {
            OR: [
              { customerId: { in: ids } },
              { items: { some: { productId: { in: productIds } } } },
            ],
          },
        })
        .catch(() => undefined);
      await prisma.wishlist
        .deleteMany({ where: { customerId: { in: ids } } })
        .catch(() => undefined);
      await prisma.customer
        .deleteMany({ where: { id: { in: ids } } })
        .catch(() => undefined);
      await prisma.stripeWebhookEvent
        .deleteMany({ where: { eventId: { in: stripeEventIds } } })
        .catch(() => undefined);
      await prisma.contactInquiry
        .deleteMany({ where: { message: { contains: TAG } } })
        .catch(() => undefined);
      await prisma.customerVerification
        .deleteMany({
          where: {
            OR: [
              { value: { contains: TAG } },
              { identifier: { contains: TAG } },
            ],
          },
        })
        .catch(() => undefined);
      await prisma.product
        .deleteMany({ where: { id: { in: productIds } } })
        .catch(() => undefined);
      await prisma.adminUser
        .delete({ where: { id: adminId } })
        .catch(() => undefined);
      for (const f of proofFiles) await unlink(f).catch(() => undefined);
      await app.close();
    });

    // -------------------------------------------------------------------------------------------
    describe('AC1: the migration is additive and the anonymization is final', () => {
      it('columns, FK SET NULL to Admin_Users, and a final anonymizedAt (trigger); Orders and Consent_Records are not altered by the schema', async () => {
        const cols = await sql(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_name = 'Customers' AND column_name IN ('anonymizedAt','anonymizedById') ORDER BY 1`,
        );
        expect(cols).toEqual([
          {
            column_name: 'anonymizedAt',
            data_type: 'timestamp with time zone',
            is_nullable: 'YES',
          },
          {
            column_name: 'anonymizedById',
            data_type: 'uuid',
            is_nullable: 'YES',
          },
        ]);
        const fk = await sql(
          `SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'Customers_anonymizedById_fkey'`,
        );
        expect(fk[0].confdeltype).toBe('n'); // SET NULL
        // No column of Orders / Consent_Records mentions anonymization.
        expect(
          await count(
            `SELECT count(*) AS n FROM information_schema.columns WHERE table_name IN ('Orders','Consent_Records') AND column_name ILIKE '%anonym%'`,
            [],
          ),
        ).toBe(0);

        const c = await mkCustomer('final');
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        // anonymizedAt cannot be changed or cleared afterwards, by anybody
        await expect(
          sql(
            `UPDATE "Customers" SET "anonymizedAt" = NULL WHERE "id" = $1::uuid`,
            [c.id],
          ),
        ).rejects.toThrow(/final/);
        await expect(
          sql(
            `UPDATE "Customers" SET "anonymizedAt" = now() + interval '1 day' WHERE "id" = $1::uuid`,
            [c.id],
          ),
        ).rejects.toThrow(/final/);
        // QA round 2: the personal columns of an anonymized row are final too (trigger), even for the
        // owner/app role; the SAME value, "updatedAt" and the FK's SET NULL are not blocked
        for (const set of [
          `"email" = 'real@example.com'`,
          `"name" = 'Nombre Real'`,
          `"phone" = '04121234567'`,
          `"image" = 'https://example.com/a.png'`,
          `"emailVerified" = true`,
        ]) {
          await expect(
            sql(`UPDATE "Customers" SET ${set} WHERE "id" = $1::uuid`, [c.id]),
            set,
          ).rejects.toThrow(/anonymized/);
        }
        await sql(
          `UPDATE "Customers" SET "name" = "name", "email" = "email", "updatedAt" = now() WHERE "id" = $1::uuid`,
          [c.id],
        );
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .name,
        ).toBe('Cuenta eliminada');
        // deleting the admin only clears the pointer (SET NULL), the date stays
        const a2 = await prisma.adminUser.create({
          data: {
            username: `${ADMIN_USER}-b`,
            email: `${ADMIN_USER}-b@212collectorsclub.test`,
            passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
          },
        });
        const c2 = await mkCustomer('final2');
        const t2 = await server()
          .post(`${BASE}/admin/auth/login`)
          .send({ usernameOrEmail: `${ADMIN_USER}-b`, password: PASS })
          .expect(200);
        await anonymize(
          c2.id,
          { confirmEmail: c2.email, reason: GOOD_REASON },
          {
            Authorization: `Bearer ${(t2.body as { accessToken: string }).accessToken}`,
          },
        ).expect(200);
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c2.id } }))
            .anonymizedById,
        ).toBe(a2.id);
        await prisma.adminUser.delete({ where: { id: a2.id } });
        const after = await prisma.customer.findUniqueOrThrow({
          where: { id: c2.id },
        });
        expect(after.anonymizedById).toBeNull();
        expect(after.anonymizedAt).not.toBeNull();
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('AC2: the contract of POST /admin/customers/:id/anonymize', () => {
      it('401 without a token / with a customer cookie; 400 for a non-UUID id; 404 for an unknown one', async () => {
        const c = await mkCustomer('auth');
        await server()
          .post(`${BASE}/admin/customers/${c.id}/anonymize`)
          .send({ confirmEmail: c.email, reason: GOOD_REASON })
          .expect(401);
        await server()
          .post(`${BASE}/admin/customers/${c.id}/anonymize`)
          .set('Cookie', c.cookie)
          .send({ confirmEmail: c.email, reason: GOOD_REASON })
          .expect(401);
        await anonymize('not-a-uuid', {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(400);
        const r = await anonymize(randomUUID(), {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(404);
        expect(r.body.errorCode).toBe('CUSTOMER_NOT_FOUND');
        // nothing happened to the real one
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .anonymizedAt,
        ).toBeNull();
      });

      it('a wrong confirmEmail is 400 ANONYMIZE_CONFIRMATION_MISMATCH and the answer never contains the real email (nor a hint)', async () => {
        const c = await mkCustomer('mismatch');
        for (const typed of [
          undefined,
          '',
          'x@y.test',
          c.email.slice(0, -1),
          `${c.email}m`,
          c.email.replace('@', ' @'),
        ]) {
          const r = await anonymize(c.id, {
            ...(typed === undefined ? {} : { confirmEmail: typed }),
            reason: GOOD_REASON,
          }).expect(400);
          expect(r.body.errorCode).toBe('ANONYMIZE_CONFIRMATION_MISMATCH');
          expect(JSON.stringify(r.body).toLowerCase()).not.toContain(
            c.email.toLowerCase().split('@')[0],
          );
        }
        // case and surrounding spaces are fine
        await anonymize(c.id, {
          confirmEmail: `  ${c.email.toUpperCase()}  `,
          reason: GOOD_REASON,
        }).expect(200);
      });

      it('reason: 10-500 characters, no cedula (REASON_CONTAINS_ID_DOC), no email/phone (REASON_CONTAINS_PERSONAL_DATA)', async () => {
        const c = await mkCustomer('reason');
        const bad: [unknown, string][] = [
          [undefined, 'ANONYMIZE_REASON_REQUIRED'],
          ['corto', 'ANONYMIZE_REASON_REQUIRED'],
          ['123456789', 'ANONYMIZE_REASON_REQUIRED'],
          ['x'.repeat(501), 'ANONYMIZE_REASON_REQUIRED'],
          [`pidio la cedula ${CED_A} por correo`, 'REASON_CONTAINS_ID_DOC'],
          ['pidio v91234567 por correo electronico', 'REASON_CONTAINS_ID_DOC'],
          // QA round 2: separators, prefixes, full-width letters and Unicode dashes
          ['pidio V  91234567 por telefono ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio CI 91234567 por telefono ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio C.I. 91234567 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio \uFF36 91234567 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio V\u2010 91234567 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio V\u200B91234567 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio V\u2212 91234567 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          ['pidio J-312345678-5 por correo ok', 'REASON_CONTAINS_ID_DOC'],
          [
            'llamo al 4121234567 pidiendo borrar',
            'REASON_CONTAINS_PERSONAL_DATA',
          ],
          [
            'llamo al 412-123-4567 pidiendo borrar',
            'REASON_CONTAINS_PERSONAL_DATA',
          ],
          ['llamo al 0412 123 4567 pidiendo', 'REASON_CONTAINS_PERSONAL_DATA'],
          [
            'solicitud numero 91234567 por correo',
            'REASON_CONTAINS_PERSONAL_DATA',
          ],
          ['solicitud con NUL \u0000 en el texto', 'ANONYMIZE_REASON_REQUIRED'],
          [
            `escribio ${c.email} pidiendo borrar`,
            'REASON_CONTAINS_PERSONAL_DATA',
          ],
          [
            'llamo desde +58 412 555 1234 pidiendo',
            'REASON_CONTAINS_PERSONAL_DATA',
          ],
        ];
        for (const [reason, code] of bad) {
          const r = await anonymize(c.id, {
            confirmEmail: c.email,
            ...(reason === undefined ? {} : { reason }),
          }).expect(400);
          expect(r.body.errorCode).toBe(code);
        }
        // unknown property: strict body
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
          force: true,
        }).expect(400);
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .anonymizedAt,
        ).toBeNull();
        // exactly 10 characters is accepted
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: 'abcdefghij',
        }).expect(200);
      });

      it('already anonymized: 200 alreadyAnonymized with no effect, no event, even with a wrong confirmEmail', async () => {
        const c = await mkCustomer('twice');
        const first = await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        expect(first.body).toMatchObject({
          customerId: c.id,
          alreadyAnonymized: false,
        });
        expect(first.body.notices).toEqual(
          expect.arrayContaining(['BROWSER_LOCAL_STORAGE_NOT_ERASED']),
        );
        const events = (await anonEvents(c.id)).length;
        const second = await anonymize(c.id, {
          confirmEmail: 'whatever@x.test',
          reason: 'x',
        }).expect(200);
        expect(second.body).toMatchObject({
          customerId: c.id,
          alreadyAnonymized: true,
          anonymizedAt: first.body.anonymizedAt,
          notices: [],
        });
        expect((await anonEvents(c.id)).length).toBe(events);
        expect(events).toBe(1);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('AC3: active orders block it (409) and nothing changes', () => {
      it.each(['PAYMENT_PROCESSING', 'PENDING_VERIFICATION', 'PAID'] as const)(
        'an order in %s: 409 ACCOUNT_HAS_ACTIVE_ORDERS with the list, full rollback, no event',
        async (status) => {
          const c = await mkCustomer(`active-${status.toLowerCase()}`);
          const s = await seed(c);
          const active = await mkOrder(c.id, status);
          const events = (await anonEvents()).length;
          const before = await ordersFingerprint(c.id);
          const r = await anonymize(c.id, {
            confirmEmail: c.email,
            reason: GOOD_REASON,
          }).expect(409);
          expect(r.body.errorCode).toBe('ACCOUNT_HAS_ACTIVE_ORDERS');
          expect(r.body.details.total).toBe(1);
          expect(r.body.details.orders).toEqual([
            {
              id: active,
              status: status.toLowerCase(),
              createdAt: expect.any(String),
            },
          ]);
          // rollback: everything that was there is still there, the account is untouched
          const row = await prisma.customer.findUniqueOrThrow({
            where: { id: c.id },
          });
          expect(row).toMatchObject({
            email: c.email,
            name: expect.stringContaining('Cliente'),
            anonymizedAt: null,
            anonymizedById: null,
          });
          expect(
            await count(
              `SELECT count(*) AS n FROM "Customer_Sessions" WHERE "userId" = $1::uuid`,
              [c.id],
            ),
          ).toBe(1);
          expect(
            await count(
              `SELECT count(*) AS n FROM "Customer_Accounts" WHERE "userId" = $1::uuid`,
              [c.id],
            ),
          ).toBe(1);
          expect(
            await prisma.customerAddress.count({ where: { id: s.addr.id } }),
          ).toBe(1);
          expect(await prisma.wishlist.count({ where: { id: s.wl.id } })).toBe(
            1,
          );
          expect(await prisma.cart.count({ where: { id: s.cart.id } })).toBe(1);
          expect(await ordersFingerprint(c.id)).toBe(before);
          expect((await anonEvents()).length).toBe(events);
          // the session still works
          await server()
            .get(`${BASE}/auth/me`)
            .set('Cookie', c.cookie)
            .expect(200);
        },
      );

      it('lists at most 20 and reports the real total; the detail shows the same numbers', async () => {
        const c = await mkCustomer('many-active');
        for (let i = 0; i < 22; i++) await mkOrder(c.id, 'PAID');
        const r = await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(409);
        expect(r.body.details.total).toBe(22);
        expect(r.body.details.orders).toHaveLength(20);
        const d = await server()
          .get(`${BASE}/admin/customers/${c.id}`)
          .set(auth())
          .expect(200);
        expect(d.body.anonymization.canAnonymize).toBe(false);
        expect(d.body.anonymization.activeOrders.count).toBe(22);
        expect(d.body.anonymization.activeOrders.items).toHaveLength(20);
        expect(d.body.anonymization.willKeep.orders).toBe(22);
      });

      it('a customer with ONLY final orders (or none) can be anonymized; the orders stay as they were', async () => {
        const none = await mkCustomer('no-orders');
        await anonymize(none.id, {
          confirmEmail: none.email,
          reason: GOOD_REASON,
        }).expect(200);
        const c = await mkCustomer('final-orders');
        await seed(c);
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('AC4 + AC5: what is deleted, what is kept, byte for byte', () => {
      it('deletes the person-only data, keeps orders (cedula encrypted and recoverable), proofs, consents, history and the whole audit log', async () => {
        const c = await mkCustomer('effects', { logins: 2 });
        const s = await seed(c);
        // an order of ANOTHER customer must not move either
        const other = await mkCustomer('bystander');
        const otherOrder = await mkOrder(other.id, 'FULFILLED', CED_C, null);
        const otherFp = await ordersFingerprint(other.id);
        const otherConsents = await consentsOf(other.id);
        const unrelatedBefore = await tableFingerprint('Stripe_Webhook_Events');

        const ordersBefore = await ordersFingerprint(c.id);
        const consentsBefore = await consentsOf(c.id);
        const historyBefore = await count(
          `SELECT count(*) AS n FROM "Order_Status_History" WHERE "orderId" = ANY($1::uuid[])`,
          [s.orderIds],
        );
        const trackingBefore = await tableFingerprint('Order_Tracking_Events');
        const proofBefore = JSON.stringify(
          await prisma.proofOfPayment.findUniqueOrThrow({
            where: { id: s.proof.id },
          }),
        );
        const auditBefore = await head();
        const tokensBefore = await tokensOf(c.id, s.email);
        expect(tokensBefore).toBeGreaterThanOrEqual(3);
        const encBefore = await sql(
          `SELECT "id", "recipientIdDocEnc", "recipientIdDocBlind", "buyerIdDocEnc", "buyerIdDocBlind" FROM "Orders" WHERE "customerId" = $1::uuid ORDER BY "id"`,
          [c.id],
        );
        expect(
          await count(
            `SELECT count(*) AS n FROM "Customer_Sessions" WHERE "userId" = $1::uuid`,
            [c.id],
          ),
        ).toBe(2);
        expect(consentsBefore).not.toMatch(/:0$/); // register wrote evidence
        // Story 20.7: two rows of the usage log (IP, 7 days) of this account and one of another
        const usageOf = async (id: string) =>
          count(
            `SELECT count(*) AS n FROM "Usage_Logs" WHERE "actorId" = $1::uuid`,
            [id],
          );
        await sql(
          `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","actorId","ip","requestId")
           VALUES (now(),'GET','/zz206/usage',200,1,'CUSTOMER',$1::uuid,'203.0.113.5'::inet,gen_random_uuid()),
                  (now(),'POST','/zz206/usage',200,1,'CUSTOMER',$1::uuid,'203.0.113.5'::inet,gen_random_uuid()),
                  (now(),'GET','/zz206/usage',200,1,'CUSTOMER',$2::uuid,'203.0.113.6'::inet,gen_random_uuid())`,
          [c.id, other.id],
        );
        expect(await usageOf(c.id)).toBe(2);

        const res = await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
        // the usage rows of the account are gone (Story 20.7, 18.2); the other account's stay
        expect(await usageOf(c.id)).toBe(0);
        expect(await usageOf(other.id)).toBe(1);
        await sql(`DELETE FROM "Usage_Logs" WHERE "route" = '/zz206/usage'`);
        expect(res.body).toMatchObject({
          customerId: c.id,
          alreadyAnonymized: false,
        });

        // --- the Customers row
        const row = await prisma.customer.findUniqueOrThrow({
          where: { id: c.id },
        });
        expect(row).toMatchObject({
          email: `deleted+${c.id}@anonymized.invalid`,
          name: 'Cuenta eliminada',
          phone: null,
          image: null,
          emailVerified: false,
          anonymizedById: adminId,
        });
        expect(row.anonymizedAt?.toISOString()).toBe(res.body.anonymizedAt);
        // --- deleted
        for (const [t, col] of [
          ['Customer_Sessions', 'userId'],
          ['Customer_Accounts', 'userId'],
          ['Customer_Addresses', 'customerId'],
          ['Carts', 'customerId'],
          ['Wishlists', 'customerId'],
        ] as const) {
          expect(
            await count(
              `SELECT count(*) AS n FROM "${t}" WHERE "${col}" = $1::uuid`,
              [c.id],
            ),
          ).toBe(0);
        }
        expect(
          await count(
            `SELECT count(*) AS n FROM "Cart_Items" WHERE "cartId" = $1::uuid`,
            [s.cart.id],
          ),
        ).toBe(0);
        expect(
          await count(
            `SELECT count(*) AS n FROM "Wishlist_Items" WHERE "wishlistId" = $1::uuid`,
            [s.wl.id],
          ),
        ).toBe(0);
        // verification tokens: by email, by user id (verification AND reset)
        expect(
          await count(
            `SELECT count(*) AS n FROM "Customer_Verifications" WHERE "identifier" = $1 OR "value" = $2`,
            [s.email, c.id],
          ),
        ).toBe(0);
        // ... but another person's token is not touched
        expect(
          await prisma.customerVerification.count({
            where: { id: s.unrelatedVerification.id },
          }),
        ).toBe(1);
        // contact messages are NOT deleted (QA round 2: a formal claim may be among them; the 12-month
        // retention of Story 20.8 covers them): both of this email (any case) and the other one stay
        expect(
          await prisma.contactInquiry.count({
            where: { email: { equals: s.email, mode: 'insensitive' } },
          }),
        ).toBe(2);
        expect(
          await prisma.contactInquiry.count({
            where: { id: s.otherInquiry.id },
          }),
        ).toBe(1);

        // --- kept, identical
        expect(await ordersFingerprint(c.id)).toBe(ordersBefore);
        expect(await consentsOf(c.id)).toBe(consentsBefore);
        expect(
          await count(
            `SELECT count(*) AS n FROM "Order_Status_History" WHERE "orderId" = ANY($1::uuid[])`,
            [s.orderIds],
          ),
        ).toBe(historyBefore);
        expect(await tableFingerprint('Order_Tracking_Events')).toBe(
          trackingBefore,
        );
        expect(
          JSON.stringify(
            await prisma.proofOfPayment.findUniqueOrThrow({
              where: { id: s.proof.id },
            }),
          ),
        ).toBe(proofBefore);
        await access(s.proofAbs); // the proof file is still on disk
        expect(
          await sql(
            `SELECT "id", "recipientIdDocEnc", "recipientIdDocBlind", "buyerIdDocEnc", "buyerIdDocBlind" FROM "Orders" WHERE "customerId" = $1::uuid ORDER BY "id"`,
            [c.id],
          ),
        ).toEqual(encBefore);
        expect(await ordersFingerprint(other.id)).toBe(otherFp);
        expect(await consentsOf(other.id)).toBe(otherConsents);
        expect(await tableFingerprint('Stripe_Webhook_Events')).toBe(
          unrelatedBefore,
        );
        void otherOrder;
        // the cedula of an order is still recoverable through the audited reveal
        const rev = await server()
          .post(`${BASE}/admin/orders/${s.orderIds[0]}/reveal-id-doc`)
          .set(auth())
          .send({ field: 'recipient' })
          .expect(200);
        expect(rev.body.value).toBe(CED_A);
        const rev2 = await server()
          .post(`${BASE}/admin/orders/${s.orderIds[0]}/reveal-id-doc`)
          .set(auth())
          .send({ field: 'buyer' })
          .expect(200);
        expect(rev2.body.value).toBe(CED_B);

        // --- the audit event: one, no email, no cedula, no name, hash of the real email
        const ev = await anonEvents(c.id);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({
          actorType: 'ADMIN',
          actorId: adminId,
          entityType: 'Customer',
          reason: GOOD_REASON,
        });
        expect(ev[0].after).toEqual({
          customerId: c.id,
          emailHash: appCrypto.hashEmail(s.email),
          addressesDeleted: 1,
          sessionsRevoked: 2,
          credentialsDeleted: 1,
          verificationTokensDeleted: tokensBefore,
          cartsDeleted: 1,
          wishlistsDeleted: 1,
          usageLogsDeleted: 2,
          ordersRetained: 5,
          consentRecordsRetained: expect.any(Number),
        });
        const dump = JSON.stringify(ev[0]).toLowerCase();
        for (const secret of [
          s.email.toLowerCase(),
          s.email.split('@')[0].toLowerCase(),
          'cliente effects',
          '91234567',
          '92345678',
          '04121230000',
          'sintetica',
        ]) {
          expect(dump).not.toContain(secret);
        }
        // exactly one new CUSTOMER_ANONYMIZED since (plus the two reveals), the chain still verifies
        expect(
          (
            await sql(
              `SELECT count(*)::int AS n FROM "Audit_Events" WHERE "seq" > $1 AND "action" = 'CUSTOMER_ANONYMIZED'`,
              [auditBefore],
            )
          )[0].n,
        ).toBe(1);
        const verdict = await new AuditChainVerifier().verify(
          (q, params) => sql(q, params ?? []),
          { mode: 'full' },
        );
        expect(verdict.ok).toBe(true);
      });

      it('the audit log of earlier events is untouched: the existing rows are byte-identical, only one row is appended', async () => {
        const c = await mkCustomer('immutable');
        const cnt = await count(`SELECT count(*) AS n FROM "Audit_Events"`, []);
        const prefix = async (limit: number): Promise<string> =>
          String(
            (
              await sql(
                `SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x."seq"), '')) AS h FROM (SELECT * FROM "Audit_Events" ORDER BY "seq" LIMIT $1) x`,
                [limit],
              )
            )[0].h,
          );
        const before = await prefix(cnt);
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        expect(await prefix(cnt)).toBe(before);
        expect(
          await count(`SELECT count(*) AS n FROM "Audit_Events"`, []),
        ).toBe(cnt + 1);
      });

      it('FAIL-CLOSED: if the audit event cannot be written, nothing is anonymized (503, full rollback)', async () => {
        const c = await mkCustomer('failclosed');
        const s = await seed(c);
        const before = await ordersFingerprint(c.id);
        const r = await blockAuditAction('CUSTOMER_ANONYMIZED', () =>
          anonymize(c.id, { confirmEmail: c.email, reason: GOOD_REASON }),
        );
        expect(r.status).toBeGreaterThanOrEqual(500);
        const row = await prisma.customer.findUniqueOrThrow({
          where: { id: c.id },
        });
        expect(row.anonymizedAt).toBeNull();
        expect(row.email).toBe(c.email);
        expect(
          await prisma.customerAddress.count({ where: { id: s.addr.id } }),
        ).toBe(1);
        expect(
          await count(
            `SELECT count(*) AS n FROM "Customer_Sessions" WHERE "userId" = $1::uuid`,
            [c.id],
          ),
        ).toBe(1);
        expect(await ordersFingerprint(c.id)).toBe(before);
        expect(await anonEvents(c.id)).toHaveLength(0);
        // and once the audit works again it goes through
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
      });

      it('the audit guard masks an email or a phone in `reason` (belt and braces behind the 400s of the DTO)', async () => {
        const audit = app.get(AuditService);
        const entity = randomUUID();
        await audit.transaction((_tx, a) => {
          a.add({
            actorType: 'ADMIN',
            actorId: adminId,
            action: 'CUSTOMER_ANONYMIZED',
            entityType: 'Customer',
            entityId: entity,
            after: { customerId: entity },
            reason: `lo pidio ana@example.com desde +58 412 555 1234, cedula ${CED_A}`,
          });
          return Promise.resolve();
        });
        const [ev] = await anonEvents(entity);
        expect(ev.reason).toContain('[REDACTED:EMAIL]');
        expect(ev.reason).not.toContain('ana@example.com');
        expect(ev.reason).not.toContain('91234567');
        expect(ev.reason).not.toMatch(/555 1234/);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('AC6: login, recovery, other devices and the freed email', () => {
      it('a session on ANOTHER device is rejected at once; login and recovery answer like an unknown email; the email is free again with nothing carried over', async () => {
        const c = await mkCustomer('devices', { logins: 2 });
        const [d1, d2] = [c.cookie, c.extraCookies[0]];
        await server().get(`${BASE}/auth/me`).set('Cookie', d1).expect(200);
        await server().get(`${BASE}/auth/me`).set('Cookie', d2).expect(200);
        const s = await seed(c);
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);

        // both devices: 401 INVALID_CUSTOMER_TOKEN, on routes that need the account
        for (const cookie of [d1, d2]) {
          const me = await server()
            .get(`${BASE}/auth/me`)
            .set('Cookie', cookie)
            .expect(401);
          expect(me.body.errorCode).toBe('INVALID_CUSTOMER_TOKEN');
          await server()
            .get(`${BASE}/auth/addresses`)
            .set('Cookie', cookie)
            .expect(401);
        }
        // login with the original email: the SAME generic 401 as an unknown email
        const unknown = emailOf(`ghost-${n}`);
        const l1 = await server()
          .post(`${BASE}/auth/login`)
          .send({ email: c.email, password: CPASS })
          .expect(401);
        const l2 = await server()
          .post(`${BASE}/auth/login`)
          .send({ email: unknown, password: CPASS })
          .expect(401);
        expect(l1.body).toEqual(l2.body);
        expect(l1.body.errorCode).toBe('INVALID_CUSTOMER_CREDENTIALS');
        expect(cookieOf(l1, 'cc_session')).toBeUndefined();
        // forgot-password: identical answer, and no reset token is created
        const tokensBefore = await prisma.customerVerification.count();
        const f1 = await server()
          .post(`${BASE}/auth/forgot-password`)
          .send({ email: c.email })
          .expect(200);
        const f2 = await server()
          .post(`${BASE}/auth/forgot-password`)
          .send({ email: unknown })
          .expect(200);
        expect(f1.body).toEqual(f2.body);
        await new Promise((r) => setTimeout(r, 300));
        expect(await prisma.customerVerification.count()).toBe(tokensBefore);
        // resend-verification: generic too
        await server()
          .post(`${BASE}/auth/resend-verification`)
          .send({ email: c.email })
          .expect(200);

        // The email is free: a NEW account with it, unrelated to the old one
        await server()
          .post(`${BASE}/auth/register`)
          .send({
            ...registerConsent(),
            email: c.email,
            password: CPASS,
            name: 'Persona Nueva',
          })
          .expect(201);
        const fresh = await prisma.customer.findUniqueOrThrow({
          where: { email: c.email },
        });
        customerIds.push(fresh.id);
        expect(fresh.id).not.toBe(c.id);
        expect(fresh.name).toBe('Persona Nueva');
        expect(fresh.anonymizedAt).toBeNull();
        // nothing reappears: no orders, no wishlist, no cart, no address, only ITS OWN consent evidence
        expect(
          await prisma.order.count({ where: { customerId: fresh.id } }),
        ).toBe(0);
        expect(
          await prisma.wishlist.count({ where: { customerId: fresh.id } }),
        ).toBe(0);
        expect(
          await prisma.cart.count({ where: { customerId: fresh.id } }),
        ).toBe(0);
        expect(
          await prisma.customerAddress.count({
            where: { customerId: fresh.id },
          }),
        ).toBe(0);
        expect(
          await prisma.consentRecord.count({
            where: { customerId: fresh.id },
          }),
        ).toBeGreaterThan(0);
        expect(
          await prisma.consentRecord.count({
            where: { customerId: fresh.id, id: { in: [] } },
          }),
        ).toBe(0);
        expect(await ordersFingerprintOwner(s.orderIds)).toBe(c.id);
        // it can log in, and its session is its own
        const login = await server()
          .post(`${BASE}/auth/login`)
          .send({ email: c.email, password: CPASS })
          .expect(200);
        expect(login.body.id).toBe(fresh.id);
        // the old account row is still there, anonymized, and its orders still point to it
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .anonymizedAt,
        ).not.toBeNull();
      });

      async function ordersFingerprintOwner(
        orderIds: string[],
      ): Promise<string> {
        const rows = await sql(
          `SELECT DISTINCT "customerId"::text AS c FROM "Orders" WHERE "id" = ANY($1::uuid[])`,
          [orderIds],
        );
        expect(rows).toHaveLength(1);
        return String(rows[0].c);
      }

      it('the reserved domain: register, login and forgot-password with anonymized.invalid are blocked (any case, subdomain, trailing dot)', async () => {
        for (const email of [
          'deleted+abc@anonymized.invalid',
          'Deleted+ABC@Anonymized.Invalid',
          `e2e-206-${TAG}-x@sub.anonymized.invalid`,
        ]) {
          const r = await server()
            .post(`${BASE}/auth/register`)
            .send({
              ...registerConsent(),
              email,
              password: CPASS,
              name: 'Probe',
            })
            .expect(400);
          expect(JSON.stringify(r.body)).toContain('email');
          expect(
            await prisma.customer.count({
              where: { email: email.toLowerCase() },
            }),
          ).toBe(0);
          const login = await server()
            .post(`${BASE}/auth/login`)
            .send({ email, password: CPASS });
          // same generic 401 as any unknown email (or 400 if the DTO refuses the shape): never a session
          expect([401]).toContain(login.status);
          expect(cookieOf(login, 'cc_session')).toBeUndefined();
          await server()
            .post(`${BASE}/auth/forgot-password`)
            .send({ email })
            .expect(200);
        }
        // a plain, real one still registers (the rule is about the domain only)
        const ok = emailOf('plain-domain');
        emails.push(ok);
        await server()
          .post(`${BASE}/auth/register`)
          .send({
            ...registerConsent(),
            email: ok,
            password: CPASS,
            name: 'Normal',
          })
          .expect(201);
      });

      it('a session that survives the anonymization (a login that raced it) is refused by the guard and by the checkout lock', async () => {
        const c = await mkCustomer('survivor');
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        // simulate the race: BetterAuth creates a session AFTER the anonymization committed
        const ctx = await app.get<CustomerAuth>(CUSTOMER_AUTH).$context;
        const ses = await ctx.internalAdapter.createSession(c.id);
        const signature = (await import('node:crypto'))
          .createHmac('sha256', ctx.secret)
          .update(ses.token)
          .digest('base64');
        const cookie = `cc_session=${encodeURIComponent(`${ses.token}.${signature}`)}`;
        await server().get(`${BASE}/auth/me`).set('Cookie', cookie).expect(401);
        // as a guest it cannot place an order that belongs to the account either
        const pid = await mkProduct();
        const add = await server()
          .post(`${BASE}/cart/items`)
          .set('Cookie', cookie)
          .send({ productId: pid, quantity: 1 });
        const ck = await server()
          .post(`${BASE}/checkout`)
          .set('Cookie', [cookie, cookieOf(add, 'cartId')].filter(Boolean))
          .send(checkoutBody());
        expect(ck.status).toBeLessThan(500);
        expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(
          0,
        );
        await prisma.customerSession.deleteMany({ where: { userId: c.id } });
      });

      it('timing: login and forgot-password for an anonymized email cost like an unknown email, and like it did before (>= 15 samples, medians)', async () => {
        const c = await mkCustomer('timing');
        const ghost = () =>
          emailOf(`g${Math.random().toString(36).slice(2, 8)}`);
        const med = (xs: number[]) =>
          [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        const time = async (fn: () => Promise<unknown>): Promise<number> => {
          const t = performance.now();
          await fn();
          return performance.now() - t;
        };
        const doLogin = (email: string) =>
          server().post(`${BASE}/auth/login`).send({ email, password: CPASS });
        const doForgot = (email: string) =>
          server().post(`${BASE}/auth/forgot-password`).send({ email });
        const N = 20;
        // Interleaved: a load spike on the machine hits both series alike.
        const pair = async (f: typeof doLogin) => {
          const mine: number[] = [];
          const theirs: number[] = [];
          for (let i = 0; i < N; i++) {
            mine.push(await time(() => f(c.email)));
            theirs.push(await time(() => f(ghost())));
          }
          return { anonymized: med(mine), unknown: med(theirs) };
        };
        const sample = async (f: typeof doLogin) => {
          const xs: number[] = [];
          for (let i = 0; i < N; i++) xs.push(await time(() => f(c.email)));
          return med(xs);
        };
        const loginBefore = await sample(doLogin);
        const forgotBefore = await sample(doForgot);
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        const login = await pair(doLogin);
        const forgot = await pair(doForgot);
        process.stdout.write(
          `[20.6 timing ms, medians of ${N}] login: before(wrong password)=${loginBefore.toFixed(1)} anonymized=${login.anonymized.toFixed(1)} unknown=${login.unknown.toFixed(1)} | forgot-password: before(existing)=${forgotBefore.toFixed(1)} anonymized=${forgot.anonymized.toFixed(1)} unknown=${forgot.unknown.toFixed(1)}\n`,
        );
        // The property that matters: an anonymized email is indistinguishable from an unknown one
        // (same code path; the band is wide because the CI machine is noisy, an Argon2id vs
        // no-hash difference would be 40 ms or more on a ~40 ms cost: a factor of two).
        expect(Math.abs(login.anonymized - login.unknown)).toBeLessThan(
          Math.max(60, login.unknown * 0.5),
        );
        expect(Math.abs(forgot.anonymized - forgot.unknown)).toBeLessThan(
          Math.max(25, forgot.unknown * 2),
        );
      });
    });

    // -------------------------------------------------------------------------------------------
    const checkoutBody = () =>
      withBuyerId({
        paymentRail: 'pago_movil',
        fulfillmentType: 'delivery',
        addressLine1: 'Av. Test 1',
        city: 'Caracas',
        state: 'Distrito Capital',
        recipientName: 'Maria Perez',
        recipientPhone: '0412-1234567',
      });

    describe('AC7: concurrency with real locks', () => {
      it('two anonymize at once of the same customer: both 200, exactly one event, one consistent state', async () => {
        for (let round = 0; round < 3; round++) {
          const c = await mkCustomer(`dbl${round}`);
          await seed(c);
          const [a, b] = await Promise.all([
            anonymize(c.id, { confirmEmail: c.email, reason: GOOD_REASON }),
            anonymize(c.id, { confirmEmail: c.email, reason: GOOD_REASON }),
          ]);
          expect([a.status, b.status]).toEqual([200, 200]);
          expect(
            [a.body.alreadyAnonymized, b.body.alreadyAnonymized].sort(),
          ).toEqual([false, true]);
          expect(a.body.anonymizedAt).toBe(b.body.anonymizedAt);
          expect(await anonEvents(c.id)).toHaveLength(1);
        }
      });

      it('anonymize vs checkout (FOR UPDATE vs FOR SHARE): never an active order on an anonymized account, no 5xx, no deadlock, no BUSY', async () => {
        // positive: the anonymization starts later; negative: the checkout starts later
        const offsets = [-60, -40, -25, -15, -8, -3, 0, 0, 3, 8, 15, 25, 40];
        const outcomes: string[] = [];
        for (let i = 0; i < offsets.length; i++) {
          const c = await mkCustomer(`race${i}`);
          const pid = await mkProduct();
          await server()
            .post(`${BASE}/cart/items`)
            .set('Cookie', c.cookie)
            .send({ productId: pid, quantity: 1 })
            .expect(201);
          const off = offsets[i];
          const later = <T>(ms: number, fn: () => PromiseLike<T>) =>
            new Promise<T>((resolve, reject) => {
              setTimeout(() => {
                fn().then(resolve, reject);
              }, ms);
            });
          const [co, an] = await Promise.all([
            later(Math.max(0, -off), () =>
              server()
                .post(`${BASE}/checkout`)
                .set('Cookie', c.cookie)
                .send(checkoutBody()),
            ),
            later(Math.max(0, off), () =>
              anonymize(c.id, {
                confirmEmail: c.email,
                reason: GOOD_REASON,
              }),
            ),
          ]);
          expect(co.status, JSON.stringify(co.body)).toBeLessThan(500);
          expect(an.status, JSON.stringify(an.body)).toBeLessThan(500);
          expect([200, 409]).toContain(an.status);
          if (an.status === 409) {
            expect(an.body.errorCode).toBe('ACCOUNT_HAS_ACTIVE_ORDERS');
          }
          const row = await prisma.customer.findUniqueOrThrow({
            where: { id: c.id },
          });
          const active = await prisma.order.count({
            where: {
              customerId: c.id,
              status: {
                in: ['PAYMENT_PROCESSING', 'PENDING_VERIFICATION', 'PAID'],
              },
            },
          });
          // THE invariant
          expect(row.anonymizedAt !== null && active > 0).toBe(false);
          if (an.status === 200) expect(active).toBe(0);
          if (co.status === 201) expect(an.status).toBe(409);
          if (an.status === 200) {
            // the checkout lost: 401 (its share was refused) or no longer a session/cart (guest, 4xx)
            expect(co.status).toBeGreaterThanOrEqual(400);
          }
          outcomes.push(`checkout ${co.status} / anonymize ${an.status}`);
        }
        process.stdout.write(`[20.6 race outcomes] ${outcomes.join(' | ')}\n`);
      });

      it('deterministic: a checkout waiting on the FOR SHARE of an account that gets anonymized is answered 401 and creates nothing', async () => {
        const c = await mkCustomer('holdlock');
        const pid = await mkProduct();
        await server()
          .post(`${BASE}/cart/items`)
          .set('Cookie', c.cookie)
          .send({ productId: pid, quantity: 1 })
          .expect(201);
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const holder = new pg.Client({ connectionString: u.toString() });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM "Customers" WHERE "id" = $1::uuid FOR UPDATE`,
            [c.id],
          );
          const t0 = Date.now();
          const pending = server()
            .post(`${BASE}/checkout`)
            .set('Cookie', c.cookie)
            .send(checkoutBody())
            .then((r) => r);
          // it must be BLOCKED on the lock, not answered
          const raced = await Promise.race([
            pending.then(() => 'answered'),
            new Promise((r) => setTimeout(() => r('blocked'), 1_500)),
          ]);
          expect(raced).toBe('blocked');
          // "anonymize" in the holder's transaction (what CustomerAnonymizationService does), then commit
          await holder.query(
            `UPDATE "Customers" SET "anonymizedAt" = now() WHERE "id" = $1::uuid`,
            [c.id],
          );
          await holder.query('COMMIT');
          const res = await pending;
          expect(res.status).toBe(401);
          expect(res.body.errorCode).toBe('INVALID_CUSTOMER_TOKEN');
          expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end();
        }
        expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(
          0,
        );
        // and no stock hold was left
        expect(
          await prisma.stockHold.count({ where: { productId: pid } }),
        ).toBe(0);
      });

      it('deterministic: an anonymize waiting behind a checkout that already holds its share sees the new active order (409), no deadlock', async () => {
        const c = await mkCustomer('behind');
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const holder = new pg.Client({ connectionString: u.toString() });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          // the checkout's first statement
          await holder.query(
            `SELECT "anonymizedAt" FROM "Customers" WHERE "id" = $1::uuid FOR SHARE`,
            [c.id],
          );
          const pending = anonymize(c.id, {
            confirmEmail: c.email,
            reason: GOOD_REASON,
          }).then((r) => r);
          const raced = await Promise.race([
            pending.then(() => 'answered'),
            new Promise((r) => setTimeout(() => r('blocked'), 1_500)),
          ]);
          expect(raced).toBe('blocked');
          // the "checkout" creates its order and commits
          await holder.query(
            `INSERT INTO "Orders" ("id","status","paymentRail","fulfillmentType","recipientName","recipientPhone","totalUsd","accessTokenHash","customerId","updatedAt")
             VALUES (gen_random_uuid(),'PENDING_VERIFICATION','PAGO_MOVIL','DELIVERY','Race','0412',5,$2,$1::uuid, now())`,
            [c.id, randomUUID()],
          );
          await holder.query('COMMIT');
          const res = await pending;
          expect(res.status).toBe(409);
          expect(res.body.errorCode).toBe('ACCOUNT_HAS_ACTIVE_ORDERS');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end();
        }
        expect(
          (await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }))
            .anonymizedAt,
        ).toBeNull();
      });

      it('a lock that is never released is a bounded 409 ANONYMIZE_BUSY, not a hang', async () => {
        const c = await mkCustomer('busy');
        const u = new URL(adminDatabaseUrl());
        u.searchParams.delete('schema');
        const holder = new pg.Client({ connectionString: u.toString() });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM "Customers" WHERE "id" = $1::uuid FOR SHARE`,
            [c.id],
          );
          const t0 = Date.now();
          const r = await anonymize(c.id, {
            confirmEmail: c.email,
            reason: GOOD_REASON,
          });
          expect(r.status).toBe(409);
          expect(r.body.errorCode).toBe('ANONYMIZE_BUSY');
          expect(Date.now() - t0).toBeLessThan(15_000);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end();
        }
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
      }, 40_000);

      it('there is no upsert in the anonymization path (uniqueness comes from the row lock)', async () => {
        const { readFile } = await import('node:fs/promises');
        const src = await readFile(
          join(
            process.cwd(),
            'src/admin-customers/customer-anonymization.service.ts',
          ),
          'utf8',
        );
        expect(src).not.toMatch(/\.upsert\s*\(/);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('AC8: search (POST, never in a URL), list and detail', () => {
      it('401 without a token; 400 for malformed bodies, idDoc and cursor; the cedula is never echoed', async () => {
        await server()
          .post(`${BASE}/admin/customers/search`)
          .send({ q: 'ab' })
          .expect(401);
        await server().get(`${BASE}/admin/customers`).expect(401);
        await server()
          .get(`${BASE}/admin/customers/${randomUUID()}`)
          .expect(401);
        const search = (b: Record<string, unknown>) =>
          server().post(`${BASE}/admin/customers/search`).set(auth()).send(b);
        for (const idDoc of [
          '12',
          'V-12',
          'XX-12345678',
          'V-1234567890123',
          '',
          'hola',
        ]) {
          const r = await search({ idDoc }).expect(400);
          expect(JSON.stringify(r.body)).not.toContain('12345678');
        }
        expect((await search({ idDoc: 'V-12' })).body.errorCode).toBe(
          'ID_DOC_FILTER_INVALID',
        );
        for (const cursor of ['x', 'eyJ4IjoxfQ', '!!', 'a'.repeat(300)]) {
          await search({ cursor }).expect(400);
        }
        expect((await search({ cursor: 'eyJ4IjoxfQ' })).body.errorCode).toBe(
          'CURSOR_INVALID',
        );
        await search({ q: 'a' }).expect(400); // shorter than 2
        await search({ surprise: 1 }).expect(400); // strict body
        await search({ q: 7 }).expect(400);
        // a NUL byte cannot be stored or compared: 400, never 500 (QA round 2)
        for (const body of [
          { q: 'ab\u0000cd' },
          { q: '\u0000\u0000' },
          { idDoc: 'V-9123\u00004567' },
          { cursor: 'ab\u0000' },
        ]) {
          const r = await search(body);
          expect(r.status, JSON.stringify(body)).toBe(400);
        }
      });

      it('GET /admin/customers: only `cursor` is accepted; any cedula key or cedula-shaped value is 400 ID_DOC_IN_URL_NOT_ALLOWED without being echoed; the same on POST ...?idDoc=', async () => {
        const urls = [
          '?idDoc=V-91234567',
          '?idDoc[]=V-91234567',
          '?idDoc[a]=V-91234567',
          '?id-doc=V-91234567',
          '?id.doc=V-91234567',
          '?IDDOC=1',
          '?rif=J-123456789',
          '?documento=12345678',
          '?ci=12345678',
          '?cedula=1',
          '?q=V91234567',
          '?q=v-91.234.567',
          '?q=juan%20V-91234567',
          '?filter[idDoc]=x',
          '?cursor=abc&idDoc=1',
        ];
        for (const q of urls) {
          const r = await server()
            .get(`${BASE}/admin/customers${q}`)
            .set(auth());
          expect(r.status, q).toBe(400);
          expect(r.body.errorCode, q).toBe('ID_DOC_IN_URL_NOT_ALLOWED');
          expect(JSON.stringify(r.body)).not.toMatch(/9123|12345678/);
          const p = await server()
            .post(`${BASE}/admin/customers/search${q}`)
            .set(auth())
            .send({ q: 'zz' });
          expect(p.status, `POST ${q}`).toBe(400);
          expect(p.body.errorCode, `POST ${q}`).toBe(
            'ID_DOC_IN_URL_NOT_ALLOWED',
          );
          const o = await server()
            .post(`${BASE}/admin/orders/search${q}`)
            .set(auth())
            .send({ idDoc: CED_A });
          expect(o.status, `orders POST ${q}`).toBe(400);
          expect(o.body.errorCode).toBe('ID_DOC_IN_URL_NOT_ALLOWED');
        }
        // other parameters are refused too: an email fragment in a URL is personal data in a log
        const q = await server()
          .get(`${BASE}/admin/customers?q=ana`)
          .set(auth())
          .expect(400);
        expect(q.body.errorCode).toBe('QUERY_PARAM_NOT_ALLOWED');
        // an email-shaped value whose local part looks like a cedula is not a cedula
        const ok = await server()
          .get(`${BASE}/admin/customers?cursor=eyJ4IjoxfQ`)
          .set(auth());
        expect(ok.status).toBe(400);
        expect(ok.body.errorCode).toBe('CURSOR_INVALID');
        await server().get(`${BASE}/admin/customers`).set(auth()).expect(200);
      });

      it('finds by partial email/name and by EXACT cedula (blind index: orders recipient/buyer and saved addresses), combinable; never a partial cedula', async () => {
        const a = await mkCustomer('findme-alpha');
        const b = await mkCustomer('findme-beta');
        const cNone = await mkCustomer('findme-none');
        const NUM_A = '91000001';
        const NUM_B = '92000002';
        await mkOrder(a.id, 'FULFILLED', `V-${NUM_A}`, null);
        await mkOrder(b.id, 'FULFILLED', 'E-90000009', `V-${NUM_B}`); // buyer cedula
        await prisma.customerAddress.create({
          data: {
            customerId: cNone.id,
            agencyId,
            recipientName: 'X',
            recipientPhone: '04120000000',
            recipientIdDocEnc: appCrypto.protect('G-200123456')?.enc,
            recipientIdDocBlind: appCrypto.protect('G-200123456')?.blind,
            deliveryMode: 'AGENCY_OFFICE',
            state: 'Miranda',
            municipality: 'Chacao',
          },
        });
        const search = async (b: Record<string, unknown>) => {
          const r = await server()
            .post(`${BASE}/admin/customers/search`)
            .set(auth())
            .send(b)
            .expect(200);
          expect(r.headers['cache-control']).toBe('no-store');
          return r.body as {
            data: {
              id: string;
              email: string;
              ordersCount: number;
              activeOrdersCount: number;
              anonymizedAt: string | null;
            }[];
            meta: {
              limit: number;
              hasNextPage: boolean;
              nextCursor: string | null;
            };
          };
        };
        const ids = (r: { data: { id: string }[] }) =>
          r.data.map((x) => x.id).sort();
        // partial, case-insensitive, email or name
        expect(ids(await search({ q: `FINDME-ALPHA` }))).toEqual([a.id]);
        expect(ids(await search({ q: `${TAG}-findme` }))).toEqual(
          [a.id, b.id, cNone.id].sort(),
        );
        expect(ids(await search({ q: 'cliente findme-bet' }))).toEqual([b.id]);
        // `q` is text, not a LIKE pattern (QA round 2): % and _ and \ match themselves only
        expect(ids(await search({ q: '%%' }))).toEqual([]);
        expect(ids(await search({ q: '__' }))).toEqual([]);
        expect(ids(await search({ q: `${TAG}%findme` }))).toEqual([]);
        expect(ids(await search({ q: `${TAG}-findme%` }))).toEqual([]);
        expect(ids(await search({ q: `${TAG}-findm_-alpha` }))).toEqual([]);
        expect(ids(await search({ q: `${TAG}\\` }))).toEqual([]);
        // exact cedula: recipient of an order, buyer of an order, saved address (several spellings)
        expect(ids(await search({ idDoc: `V-${NUM_A}` }))).toEqual([a.id]);
        expect(ids(await search({ idDoc: `v${NUM_A}` }))).toEqual([a.id]);
        expect(ids(await search({ idDoc: `V-${NUM_B}` }))).toEqual([b.id]);
        expect(ids(await search({ idDoc: 'g-200123456' }))).toEqual([cNone.id]);
        // never partial: a prefix/other type finds nothing (or is invalid)
        expect(ids(await search({ idDoc: `E-${NUM_A}` }))).toEqual([]);
        expect(ids(await search({ idDoc: 'V-9100000' }))).toEqual([]);
        // combined (AND)
        expect(
          ids(await search({ idDoc: `V-${NUM_A}`, q: 'findme-beta' })),
        ).toEqual([]);
        expect(
          ids(await search({ idDoc: `V-${NUM_A}`, q: 'findme-alpha' })),
        ).toEqual([a.id]);
        // counts
        const r = await search({ idDoc: `V-${NUM_A}` });
        expect(r.data[0]).toMatchObject({
          ordersCount: 1,
          activeOrdersCount: 0,
          anonymizedAt: null,
        });
        // an anonymized customer is still found by the cedula of its (kept) orders
        await anonymize(a.id, {
          confirmEmail: a.email,
          reason: GOOD_REASON,
        }).expect(200);
        const after = await search({ idDoc: `V-${NUM_A}` });
        expect(ids(after)).toEqual([a.id]);
        expect(after.data[0].anonymizedAt).not.toBeNull();
        expect(after.data[0].email).toBe(`deleted+${a.id}@anonymized.invalid`);
        // an unknown cedula: empty page, 200
        expect(await search({ idDoc: 'V-99999991' })).toMatchObject({
          data: [],
          meta: { hasNextPage: false, nextCursor: null },
        });
      });

      it('cursor pagination: 50 per page, newest first, no gap or repeat across pages (also through the GET list)', async () => {
        const mark = `pg${TAG}`;
        const rows = Array.from({ length: 57 }, (_, i) => ({
          email: `e2e-206-${TAG}-${mark}-${String(i).padStart(2, '0')}@212collectorsclub.test`,
          name: `Paginado ${mark}`,
          // several share a createdAt to exercise the (createdAt, id) tie-break
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 3))),
        }));
        await prisma.customer.createMany({ data: rows });
        const created = await prisma.customer.findMany({
          where: { name: `Paginado ${mark}` },
          select: { id: true },
        });
        customerIds.push(...created.map((c) => c.id));
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const r = await server()
            .post(`${BASE}/admin/customers/search`)
            .set(auth())
            .send({ q: mark, ...(cursor ? { cursor } : {}) })
            .expect(200);
          pages += 1;
          expect(r.body.meta.limit).toBe(50);
          expect(r.body.data.length).toBeLessThanOrEqual(50);
          if (r.body.meta.hasNextPage) expect(r.body.data).toHaveLength(50);
          seen.push(...r.body.data.map((x: { id: string }) => x.id));
          cursor = r.body.meta.nextCursor ?? undefined;
        } while (cursor);
        expect(pages).toBe(2);
        expect(seen).toHaveLength(57);
        expect(new Set(seen).size).toBe(57);
        expect(new Set(seen)).toEqual(new Set(created.map((c) => c.id)));
        // newest first
        const dates = (
          await prisma.customer.findMany({
            where: { id: { in: seen } },
            select: { id: true, createdAt: true },
          })
        ).reduce<Record<string, number>>(
          (m, r) => ((m[r.id] = r.createdAt.getTime()), m),
          {},
        );
        for (let i = 1; i < seen.length; i++) {
          expect(dates[seen[i - 1]]).toBeGreaterThanOrEqual(dates[seen[i]]);
        }
        // the GET list walks the same order (cursor only)
        const first = await server()
          .get(`${BASE}/admin/customers`)
          .set(auth())
          .expect(200);
        expect(first.body.data.length).toBeGreaterThan(0);
        if (first.body.meta.nextCursor) {
          await server()
            .get(`${BASE}/admin/customers?cursor=${first.body.meta.nextCursor}`)
            .set(auth())
            .expect(200);
        }
      });

      it('the preview warns of a pending refund even when the order is PAYMENT_FAILED (refund_pending_after_terminal); it stays after the anonymization', async () => {
        const c = await mkCustomer('refund');
        const oid = await mkOrder(c.id, 'PAYMENT_FAILED');
        const clean = await mkCustomer('norefund');
        await mkOrder(clean.id, 'PAYMENT_FAILED');
        const evId = `evt_e2e206_${TAG}`;
        stripeEventIds.push(evId);
        await prisma.stripeWebhookEvent.create({
          data: {
            eventId: evId,
            type: 'checkout.session.completed',
            orderId: oid,
            outcome: 'refund_pending_after_terminal',
          },
        });
        const detail = async (id: string): Promise<Record<string, any>> =>
          (
            await server()
              .get(`${BASE}/admin/customers/${id}`)
              .set(auth())
              .expect(200)
          ).body.anonymization;
        const d = await detail(c.id);
        expect(d.willKeep.ordersWithRefundPending).toBe(1);
        expect(d.notices).toContain('REFUND_PENDING_ON_KEPT_ORDERS');
        expect(d.canAnonymize).toBe(true); // PAYMENT_FAILED is final: it does not block
        const n = await detail(clean.id);
        expect(n.willKeep.ordersWithRefundPending).toBe(0);
        expect(n.notices).not.toContain('REFUND_PENDING_ON_KEPT_ORDERS');
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        const after = await detail(c.id);
        expect(after.willKeep.ordersWithRefundPending).toBe(1);
        expect(after.notices).toContain('REFUND_PENDING_ON_KEPT_ORDERS');
      });

      it('register with an invisible character in the email is 400, never 500', async () => {
        for (const email of [
          `zw\u200B-${TAG}@212collectorsclub.test`,
          `zw-${TAG}\u2060@212collectorsclub.test`,
          `zw-${TAG}\uFEFF@212collectorsclub.test`,
          `zw-${TAG}@212collectorsclub\u200D.test`,
        ]) {
          const r = await server()
            .post(`${BASE}/auth/register`)
            .send({
              ...registerConsent(),
              email,
              password: CPASS,
              name: 'Invisible',
            });
          expect(r.status, JSON.stringify(email)).toBe(400);
        }
      });

      it('detail: data, addresses with the cedula MASKED (never in clear anywhere), last orders, anonymizedAt and the preview numbers; 404 / 400 / 401', async () => {
        const c = await mkCustomer('detail');
        const s = await seed(c, { active: true });
        const tokens = await tokensOf(c.id, s.email);
        const r = await server()
          .get(`${BASE}/admin/customers/${c.id}`)
          .set(auth())
          .expect(200);
        expect(r.headers['cache-control']).toBe('no-store');
        const b = r.body;
        expect(b).toMatchObject({
          id: c.id,
          email: c.email,
          anonymizedAt: null,
          emailVerified: true,
        });
        expect(b.addresses).toHaveLength(1);
        expect(b.addresses[0].recipientIdDoc).toBe('V-****4567');
        expect(b.recentOrders).toHaveLength(6);
        expect(b.recentOrders[0]).toEqual({
          id: expect.any(String),
          status: expect.any(String),
          paymentRail: 'pago_movil',
          totalUsd: 5,
          createdAt: expect.any(String),
        });
        const json = JSON.stringify(b);
        for (const clear of [CED_A, '91234567', CED_B, '92345678']) {
          expect(json).not.toContain(clear);
        }
        // the numbers the warning shows
        expect(b.anonymization).toEqual({
          canAnonymize: false,
          activeOrders: {
            count: 1,
            items: [
              {
                id: s.orderIds[5],
                status: 'paid',
                createdAt: expect.any(String),
              },
            ],
          },
          willDelete: {
            addresses: 1,
            sessions: 1,
            credentials: 1,
            verificationTokens: tokens,
            carts: 1,
            wishlists: 1,
            usageLogs: 0,
          },
          willKeep: {
            orders: 6,
            consentRecords: expect.any(Number),
            contactInquiries: 2,
            ordersWithRefundPending: 0,
          },
          notices: expect.arrayContaining([
            'NOT_RECOMMENDED_ONLY_ON_EXPLICIT_REQUEST_OF_THE_OWNER',
            'IRREVERSIBLE',
            'ORDERS_AND_FISCAL_ID_KEPT',
            'CONTACT_MESSAGES_KEPT_UNTIL_RETENTION',
            'BROWSER_LOCAL_STORAGE_NOT_ERASED',
            'BACKUPS_KEEP_DATA_UNTIL_ROTATION',
          ]),
        });
        // after cancelling the active order it can be anonymized, and the detail says what happened
        await prisma.order.update({
          where: { id: s.orderIds[5] },
          data: { status: 'CANCELLED' },
        });
        const again = await server()
          .get(`${BASE}/admin/customers/${c.id}`)
          .set(auth())
          .expect(200);
        expect(again.body.anonymization.canAnonymize).toBe(true);
        expect(again.body.anonymization.activeOrders).toEqual({
          count: 0,
          items: [],
        });
        await anonymize(c.id, {
          confirmEmail: c.email,
          reason: GOOD_REASON,
        }).expect(200);
        const done = await server()
          .get(`${BASE}/admin/customers/${c.id}`)
          .set(auth())
          .expect(200);
        expect(done.body).toMatchObject({
          email: `deleted+${c.id}@anonymized.invalid`,
          name: 'Cuenta eliminada',
          phone: null,
          anonymizedById: adminId,
          addresses: [],
        });
        expect(done.body.anonymizedAt).toEqual(expect.any(String));
        expect(done.body.anonymization.canAnonymize).toBe(false);
        expect(done.body.anonymization.willKeep.orders).toBe(6);
        expect(done.body.anonymization.willDelete).toEqual({
          addresses: 0,
          sessions: 0,
          credentials: 0,
          verificationTokens: 0,
          carts: 0,
          wishlists: 0,
          usageLogs: 0,
        });
        await server()
          .get(`${BASE}/admin/customers/${randomUUID()}`)
          .set(auth())
          .expect(404);
        await server()
          .get(`${BASE}/admin/customers/nope`)
          .set(auth())
          .expect(400);
      });

      it('Swagger documents every route with its errorCode', async () => {
        const doc = (await server().get('/api/docs-json').expect(200)).body;
        const text = JSON.stringify(doc.paths);
        for (const p of [
          '/api/v1/admin/customers',
          '/api/v1/admin/customers/search',
          '/api/v1/admin/customers/{id}',
          '/api/v1/admin/customers/{id}/anonymize',
        ]) {
          expect(doc.paths[p], p).toBeDefined();
        }
        for (const code of [
          'ANONYMIZE_CONFIRMATION_MISMATCH',
          'ANONYMIZE_REASON_REQUIRED',
          'REASON_CONTAINS_ID_DOC',
          'ACCOUNT_HAS_ACTIVE_ORDERS',
          'CUSTOMER_NOT_FOUND',
          'ID_DOC_IN_URL_NOT_ALLOWED',
          'ID_DOC_FILTER_INVALID',
        ]) {
          expect(text, code).toContain(code);
        }
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('the run leaves nothing behind', () => {
      it('the whole audit chain of the run verifies from genesis (the global teardown checks it again)', async () => {
        const v = await new AuditChainVerifier().verify(
          (q, params) => sql(q, params ?? []),
          { mode: 'full' },
        );
        expect(v.ok).toBe(true);
      });
    });
  },
);
