import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import Stripe from 'stripe';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { applySecurityHeaders } from './../src/common/security-headers.js';
import { setupSwagger } from './../src/common/swagger-setup.js';
import { DisabledStripeClient } from './../src/payments-stripe/disabled-stripe-client.js';
import { STRIPE_CLIENT } from './../src/payments-stripe/stripe-client.interface.js';
import { FAKE_STRIPE_WEBHOOK_SECRET } from './../src/payments-stripe/fake-stripe-client.js';
import { withBuyerId } from './helpers/buyer-id.js';

type Env = Record<string, string | undefined>;

/**
 * Story 20.11 (security audit, high priority 2 and 3): the same wiring as `main.ts` (helmet, then the cookie parser,
 * prefix, versioning, pipes and Swagger), built with an explicit environment so production rules can be exercised
 * under `NODE_ENV=test`.
 */
async function build(env: Env, disableStripe = false) {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (disableStripe) {
    builder = builder
      .overrideProvider(STRIPE_CLIENT)
      .useValue(new DisabledStripeClient());
  }
  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  applySecurityHeaders(app, env);
  app.use(
    cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createGlobalValidationPipe());
  setupSwagger(app, env);
  await app.init();
  return app;
}

function sessionEvent(sessionId: string) {
  return JSON.stringify({
    id: `evt_2011_${randomUUID()}`,
    object: 'event',
    type: 'checkout.session.expired',
    data: {
      object: {
        object: 'checkout.session',
        id: sessionId,
        client_reference_id: randomUUID(),
        metadata: { orderId: randomUUID() },
        payment_status: 'unpaid',
        amount_total: 100,
        currency: 'usd',
      },
    },
  });
}

describe('Production-like app: Swagger off, helmet headers (Story 20.11)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await build({ NODE_ENV: 'production' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('/api/docs and /api/docs-json are 404 without SWAGGER_ENABLED=true', async () => {
    const http = app.getHttpServer();
    await request(http).get('/api/docs').expect(404);
    await request(http).get('/api/docs-json').expect(404);
  });

  it('sends the security headers, with HSTS, on a normal response and on a 404', async () => {
    const http = app.getHttpServer();
    for (const path of ['/api/v1/health', '/api/v1/no-such-route']) {
      const res = await request(http).get(path);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('keeps the Stripe webhook working behind helmet (raw body, signature verified; bad signature 400)', async () => {
    const http = app.getHttpServer();
    const secret =
      app.get(ConfigService).get<string>('STRIPE_WEBHOOK_SECRET') ||
      FAKE_STRIPE_WEBHOOK_SECRET;
    const payload = sessionEvent(`cs_test_${randomUUID()}`);
    const ok = await request(http)
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      )
      .send(payload)
      .expect(200);
    expect((ok.body as { received: boolean }).received).toBe(true);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    await request(http)
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=bad')
      .send(payload)
      .expect(400);
  });
});

describe('Non-production app: Swagger on, no HSTS, docs without CSP (Story 20.11)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await build({ NODE_ENV: 'test' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves /api/docs and /api/docs-json; the UI is not under the API CSP but keeps nosniff', async () => {
    const http = app.getHttpServer();
    const docs = await request(http).get('/api/docs');
    expect(docs.status).toBe(200);
    expect(docs.headers['content-security-policy']).toBeUndefined();
    expect(docs.headers['x-content-type-options']).toBe('nosniff');
    await request(http).get('/api/docs-json').expect(200);
    const api = await request(http).get('/api/v1/health');
    expect(api.headers['strict-transport-security']).toBeUndefined();
    expect(api.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });
});

describe('SWAGGER_ENABLED=true is the explicit production opt-in (Story 20.11)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await build({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' });
  });
  afterAll(async () => {
    await app.close();
  });
  it('mounts the docs', async () => {
    await request(app.getHttpServer()).get('/api/docs-json').expect(200);
  });
});

describe('STRIPE_ENABLED=false: DisabledStripeClient (Story 20.11)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await build({ NODE_ENV: 'test' }, true);
  });
  afterAll(async () => {
    await app.close();
  });

  it('checkout by Stripe answers 503 STRIPE_DISABLED before creating anything', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .send(
        withBuyerId({
          paymentRail: 'stripe',
          fulfillmentType: 'delivery',
          addressLine1: 'Av. Test 1',
          city: 'Caracas',
          state: 'Distrito Capital',
          recipientName: 'Carlos Gomez',
          recipientPhone: '0414-7654321',
        }),
      );
    expect(res.status).toBe(503);
    expect((res.body as { errorCode: string }).errorCode).toBe(
      'STRIPE_DISABLED',
    );
  });

  it('the webhook rejects even a correctly signed request', async () => {
    const payload = sessionEvent(`cs_test_${randomUUID()}`);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: FAKE_STRIPE_WEBHOOK_SECRET,
        }),
      )
      .send(payload);
    expect(res.status).toBe(400);
    expect((res.body as { errorCode: string }).errorCode).toBe(
      'STRIPE_SIGNATURE_INVALID',
    );
  });
});
