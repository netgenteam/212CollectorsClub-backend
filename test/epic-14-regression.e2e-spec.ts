import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';

const TAG = randomUUID().slice(0, 8);
const TEST_USERNAME = 'e2e-admin-story-14-7-reg';
const TEST_EMAIL = 'e2e-admin-story-14-7-reg@212collectorsclub.test';
const TEST_PASSWORD = 'correct-horse-battery-staple-14a7r';
// Built piecemeal so the repo-wide "zero trace" grep (AC7) stays clean.
const RETIRED = 'pay' + 'pal';

type Obj = Record<string, unknown>;
interface Child {
  id: string;
  inStockCount: number;
}
interface Group extends Child {
  children: Child[];
}
interface Checkout {
  orderId: string;
  orderAccessToken: string;
  status: string;
  paymentInstructions: unknown;
  stripe: { sessionId: string; url: string } | null;
}

const PRE_CHECKOUT = [
  'orderId',
  'orderAccessToken',
  'status',
  'totalUsd',
  'paymentInstructions',
];
const PRE_ORDER_LOOKUP = ['status'];

// Story 14.7 (AC3-AC7, AD-40, AD-49): Epic 14 end-to-end regression.
describe('Epic 14 regression (e2e, Story 14.7)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let adminId: string;
  let doc: { components: { schemas: Record<string, Obj> } };
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
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
    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
    });
    const admin = await prisma.adminUser.upsert({
      where: { username: TEST_USERNAME },
      create: { username: TEST_USERNAME, email: TEST_EMAIL, passwordHash },
      update: { email: TEST_EMAIL, passwordHash },
    });
    adminId = admin.id;
    const res = await request(server())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    accessToken = (res.body as { accessToken: string }).accessToken;
    doc = (await request(server()).get('/api/docs-json')).body as typeof doc;
  });

  afterAll(async () => {
    await prisma.stripeWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${TAG}` } },
    });
    await prisma.order.deleteMany({
      where: { lines: { some: { productId: { in: productIds } } } },
    });
    await prisma.cart.deleteMany({
      where: { items: { some: { productId: { in: productIds } } } },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    for (const id of [...categoryIds].reverse()) {
      await prisma.category.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.adminUser
      .delete({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const authed = (method: 'get' | 'post', path: string) =>
    request(server())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);

  async function mkCategory(body: Obj): Promise<{ id: string }> {
    const res = await authed('post', '/api/v1/admin/categories')
      .send(body)
      .expect(201);
    const c = res.body as { id: string };
    categoryIds.push(c.id);
    return c;
  }

  async function checkoutFor(
    productId: string,
    rail: 'stripe' | 'pago_movil',
    qty = 1,
  ): Promise<Checkout> {
    const add = await request(server())
      .post('/api/v1/cart/items')
      .send({ productId, quantity: qty })
      .expect(201);
    const cookie = (add.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('cartId='))!
      .split(';')[0];
    const res = await request(server())
      .post('/api/v1/checkout')
      .set('Cookie', cookie)
      .send({
        paymentRail: rail,
        fulfillmentType: 'pickup',
        recipientName: 'Maria Perez',
        recipientPhone: '0412-1234567',
      })
      .expect(201);
    return res.body as Checkout;
  }

  const secret = () =>
    app.get(ConfigService).get<string>('STRIPE_WEBHOOK_SECRET') ||
    FAKE_STRIPE_WEBHOOK_SECRET;
  const webhook = (type: string, co: Checkout, amount?: number) => {
    const payload = JSON.stringify({
      id: `evt_${TAG}_${randomUUID()}`,
      object: 'event',
      type,
      data: {
        object: {
          object: 'checkout.session',
          id: co.stripe!.sessionId,
          client_reference_id: co.orderId,
          metadata: { orderId: co.orderId },
          payment_status: amount === undefined ? 'unpaid' : 'paid',
          amount_total: amount,
          currency: 'usd',
          payment_intent: 'pi_test_147',
        },
      },
    });
    return request(server())
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: secret(),
        }),
      )
      .send(payload);
  };

  async function mkProduct(n: string, categoryId: string, stock: number) {
    const p = await prisma.product.create({
      data: {
        name: `E2E147 ${TAG} ${n}`,
        slug: `e2e147-${TAG}-${n}`,
        description: 'Created by e2e 14.7.',
        franchise: 'POKEMON',
        productType: 'BOOSTER_BOX',
        rarity: 'COMMON',
        priceUsd: '25.00',
        stock,
        heldQty: 0,
        isActive: true,
        categoryId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  const groupCount = async (rootId: string) => {
    const f = (
      await request(server()).get('/api/v1/catalog/facets').expect(200)
    ).body as { categoryGroups: Group[] };
    const g = f.categoryGroups.find((x) => x.id === rootId);
    return g;
  };
  const listTotal = async (rootId: string) =>
    (
      (
        await request(server())
          .get(`/api/v1/products?categoryId=${rootId}&onlyInStock=true`)
          .expect(200)
      ).body as { meta: { total: number } }
    ).meta.total;

  it('AC5: root+child (no dimension) -> Stripe checkout hold -> signed webhook paid; facets and listing agree before/after; expired releases hold', async () => {
    const root = await mkCategory({
      name: `Pokemon ${TAG}`,
      slug: `e2e147-${TAG}-root`,
    });
    const child = await mkCategory({
      name: `Booster Sets ${TAG}`,
      slug: `e2e147-${TAG}-child`,
      type: 'SUBCATEGORY',
      parentId: root.id,
    });
    const productId = await mkProduct('paid', child.id, 1);

    const before = await groupCount(root.id);
    expect(before?.inStockCount).toBe(1);
    expect(before?.children.map((c) => c.inStockCount)).toEqual([1]);
    expect(await listTotal(root.id)).toBe(1);

    const co = await checkoutFor(productId, 'stripe');
    expect(co.status).toBe('payment_processing');
    expect(co.stripe?.url).toBeTruthy();
    expect(co.paymentInstructions).toBeNull();
    expect(RETIRED in (co as unknown as Obj)).toBe(false);
    // hold reserves the only unit -> out of stock for everyone else
    expect((await groupCount(root.id))?.inStockCount ?? 0).toBe(0);

    const ok = await webhook('checkout.session.completed', co, 2500).expect(
      200,
    );
    expect(ok.body).toEqual({ received: true, outcome: 'paid' });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: co.orderId },
    });
    expect(order.status).toBe('PAID');
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: productId } }),
    ).toMatchObject({ stock: 0, heldQty: 0 });
    expect((await groupCount(root.id))?.inStockCount ?? 0).toBe(0);
    expect(await listTotal(root.id)).toBe(0);
    const lookup = await request(server())
      .get(`/api/v1/orders/${co.orderId}`)
      .set('Authorization', `Bearer ${co.orderAccessToken}`)
      .expect(200);
    expectSuperset(lookup.body as Obj, PRE_ORDER_LOOKUP);

    // expired path: hold released, stock back on sale
    const p2 = await mkProduct('expired', child.id, 1);
    const co2 = await checkoutFor(p2, 'stripe');
    expect((await groupCount(root.id))?.inStockCount ?? 0).toBe(0);
    await webhook('checkout.session.expired', co2).expect(200);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: co2.orderId } }))
        .status,
    ).toBe('PAYMENT_FAILED');
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: p2 } }),
    ).toMatchObject({ stock: 1, heldQty: 0 });
    expect((await groupCount(root.id))?.inStockCount).toBe(1);
    expect(await listTotal(root.id)).toBe(1);

    // admin triage filter is available and stays additive
    await authed('get', '/api/v1/admin/orders?refundPending=true').expect(200);
  });

  it('AC4: Pago Movil checkout keeps its pre-Epic-14 shape (stripe: null) and holds stock', async () => {
    const cat = await prisma.category.findFirstOrThrow();
    const productId = await mkProduct('pm', cat.id, 3);
    const co = await checkoutFor(productId, 'pago_movil', 2);
    expectSuperset(co as unknown as Obj, PRE_CHECKOUT);
    expect(co.status).toBe('pending_verification');
    expect(co.paymentInstructions).not.toBeNull();
    expect(co.stripe).toBeNull();
    expect(RETIRED in (co as unknown as Obj)).toBe(false);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: productId } }),
    ).toMatchObject({ stock: 3, heldQty: 2 });
  });

  it('AC7: retired webhook route 404s; OpenAPI has no retired-rail string and rails are pago_movil/stripe', async () => {
    await request(server())
      .post(`/api/v1/payments/${RETIRED}/webhook`)
      .send({})
      .expect(404);
    expect(JSON.stringify(doc).toLowerCase()).not.toContain(RETIRED);
    const rails = Object.entries(doc.components.schemas).flatMap(([, s]) => {
      const props = (s.properties ?? {}) as Record<string, Obj>;
      return props.paymentRail?.enum
        ? [props.paymentRail.enum as string[]]
        : [];
    });
    expect(rails.length).toBeGreaterThan(0);
    for (const e of rails) {
      expect([...e].sort()).toEqual(expect.arrayContaining(['stripe']));
      expect(e.map((v) => v.toLowerCase()).sort()).toEqual([
        'pago_movil',
        'stripe',
      ]);
    }
  });
});

describe('Epic 14 zero-trace of the retired rail (Story 14.7, AC7)', () => {
  const root = process.cwd();
  const walk = (p: string): string[] =>
    statSync(p).isDirectory()
      ? readdirSync(p).flatMap((f) =>
          ['generated', 'node_modules', 'dist', 'migrations'].includes(f)
            ? []
            : walk(join(p, f)),
        )
      : [p];

  it('no source, test, schema, seed, env, docs or deploy file mentions it', () => {
    const files = [
      ...walk(join(root, 'src')),
      ...walk(join(root, 'test')),
      ...walk(join(root, 'deploy')),
      ...[
        'prisma/schema.prisma',
        'prisma/seed.ts',
        'package.json',
        '.env.example',
        'docs/deployment.md',
        'README.md',
      ].map((f) => join(root, f)),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(20);
    // Only the bounded removal note of docs/deployment.md may mention it,
    // and only on lines carrying one of these exact literals.
    const P = 'Pay' + 'Pal';
    const allowedDocLiteral = new RegExp(
      [
        `${P.toUpperCase()}_REMOVAL_ABORTED`,
        `remove_${RETIRED}`,
        `payments/${RETIRED}/webhook`,
        `${P} (rows|removal|Order)`,
        `${P} is no longer`,
        `removes ${P}`,
        `references ${P}`,
      ].join('|'),
    );
    const hits = files.filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some(
          (line) =>
            line.toLowerCase().includes(RETIRED) &&
            !(f.endsWith('docs/deployment.md') && allowedDocLiteral.test(line)),
        ),
    );
    expect(hits).toEqual([]);
  });
});

function expectSuperset(body: Obj, pre: string[]) {
  for (const k of pre) expect(body, `missing field ${k}`).toHaveProperty(k);
}
