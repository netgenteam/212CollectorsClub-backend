import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Post, Req, VersioningType } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { STRIPE_CLIENT } from './../src/payments-stripe/stripe-client.interface.js';
import { FakeStripeClient } from './../src/payments-stripe/fake-stripe-client.js';

// Story 14.3 (AC1, AC3, AC6): test-only probe standing in for the 14.5
// webhook controller, to prove rawBody is a Buffer under the app's real
// prefix/versioning setup.
@Controller('stripe-probe')
class RawBodyProbeController {
  @Post()
  probe(@Req() req: RawBodyRequest<{ body: unknown }>) {
    return {
      isBuffer: Buffer.isBuffer(req.rawBody),
      raw: req.rawBody?.toString('utf8'),
      parsed: req.body,
    };
  }
}

describe('Stripe foundation (e2e, Story 14.3)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RawBodyProbeController],
    }).compile();

    // Mirrors main.ts: same `rawBody: true` option.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('injects FakeStripeClient when STRIPE_SECRET_KEY is unset (AC3)', () => {
    expect(app.get(STRIPE_CLIENT)).toBe(app.get(FakeStripeClient));
  });

  it('exposes req.rawBody as a Buffer while still parsing JSON (AC6)', async () => {
    const body = { a: 1, b: 'x' };
    const res = await request(app.getHttpServer())
      .post('/api/v1/stripe-probe')
      .send(body)
      .expect(201);
    const out = res.body as { isBuffer: boolean; raw: string; parsed: unknown };
    expect(out.isBuffer).toBe(true);
    expect(JSON.parse(out.raw)).toEqual(body);
    expect(out.parsed).toEqual(body);
  });

  it('an existing JSON route behaves unchanged with rawBody enabled (AC6)', async () => {
    // Invalid payload still yields the validation 400 from the JSON body.
    await request(app.getHttpServer())
      .post('/api/v1/contact')
      .send({ name: '' })
      .expect(400);
  });

  it('applies the additive schema: new enum values, columns and table (AC1)', async () => {
    const prisma = app.get(PrismaService);
    const enums = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname IN ('PaymentRail','OrderActorType')`,
    );
    const labels = enums.map((r) => r.v);
    expect(labels).toContain('STRIPE');
    expect(labels).toContain('STRIPE_WEBHOOK');

    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='Orders'
       AND column_name IN ('stripeCheckoutSessionId','stripePaymentIntentId')`,
    );
    expect(cols).toHaveLength(2);

    const table = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='Stripe_Webhook_Events'`,
    );
    expect(table.map((c) => c.column_name).sort()).toEqual([
      'eventId',
      'orderId',
      'outcome',
      'processedAt',
      'type',
    ]);
  });
});
