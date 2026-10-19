import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FakeStripeClient } from './fake-stripe-client.js';
import { StripeHttpClient } from './stripe-http-client.js';
import { stripeClientProvider } from './stripe-client.provider.js';
import {
  StripeClient,
  StripeSignatureError,
} from './stripe-client.interface.js';

const SECRET = 'whsec_unit_test_secret';

function cfg(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => {
      const v = values[k];
      if (v === undefined || v === '') throw new Error(`Missing ${k}`);
      return v;
    },
  } as unknown as ConfigService;
}

const stripeForSigning = new Stripe('sk_test_dummy');

function payloadFor(): string {
  return JSON.stringify({
    id: 'evt_123',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_abc',
        object: 'checkout.session',
        client_reference_id: 'order-uuid-1',
        metadata: { orderId: 'order-uuid-1' },
        payment_status: 'paid',
        amount_total: 4599,
        currency: 'usd',
        payment_intent: 'pi_999',
      },
    },
  });
}

function sign(payload: string, secret = SECRET, timestamp?: number): string {
  return stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
}

const implementations: Array<[string, () => StripeClient]> = [
  [
    'FakeStripeClient',
    () => new FakeStripeClient(cfg({ STRIPE_WEBHOOK_SECRET: SECRET })),
  ],
  [
    'StripeHttpClient',
    () =>
      new StripeHttpClient(
        cfg({
          STRIPE_SECRET_KEY: 'sk_test_dummy',
          STRIPE_WEBHOOK_SECRET: SECRET,
        }),
      ),
  ],
];

describe.each(implementations)('%s.parseWebhook (AC5)', (_name, make) => {
  it('returns the normalized event for a correctly signed payload', () => {
    const payload = payloadFor();
    const event = make().parseWebhook(Buffer.from(payload), sign(payload));
    expect(event).toEqual({
      id: 'evt_123',
      type: 'checkout.session.completed',
      sessionId: 'cs_test_abc',
      orderId: 'order-uuid-1',
      paymentStatus: 'paid',
      amountTotalCents: 4599,
      currency: 'usd',
      paymentIntentId: 'pi_999',
    });
  });

  it('throws StripeSignatureError when the signature is missing', () => {
    expect(() =>
      make().parseWebhook(Buffer.from(payloadFor()), undefined),
    ).toThrow(StripeSignatureError);
  });

  it('throws StripeSignatureError when the signature is malformed', () => {
    expect(() =>
      make().parseWebhook(Buffer.from(payloadFor()), 'garbage'),
    ).toThrow(StripeSignatureError);
  });

  it('throws StripeSignatureError for a wrong secret', () => {
    const payload = payloadFor();
    expect(() =>
      make().parseWebhook(Buffer.from(payload), sign(payload, 'whsec_other')),
    ).toThrow(StripeSignatureError);
  });

  it('throws StripeSignatureError for a stale timestamp', () => {
    const payload = payloadFor();
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() =>
      make().parseWebhook(Buffer.from(payload), sign(payload, SECRET, old)),
    ).toThrow(StripeSignatureError);
  });

  it('throws StripeSignatureError when the body was tampered with', () => {
    const payload = payloadFor();
    expect(() =>
      make().parseWebhook(Buffer.from(payload + ' '), sign(payload)),
    ).toThrow(StripeSignatureError);
  });
});

describe('FakeStripeClient.createCheckoutSession (AC3)', () => {
  it('returns cs_test_fake_<uuid> and a fake url', async () => {
    const res = await new FakeStripeClient(cfg({})).createCheckoutSession({
      orderId: 'o1',
      lines: [{ name: 'Card', unitAmountCents: 100, quantity: 1 }],
      currency: 'usd',
      successUrl: 'http://x/s',
      cancelUrl: 'http://x/c',
      expiresAt: new Date(),
    });
    expect(res.sessionId).toMatch(
      /^cs_test_fake_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.url).toMatch(/^https:\/\/stripe\.fake\/checkout\//);
  });
});

describe('stripeClientProvider (AC3, AC4)', () => {
  type Factory = (c: ConfigService, f: FakeStripeClient) => StripeClient;
  const factory = (stripeClientProvider as unknown as { useFactory: Factory })
    .useFactory;

  it('injects the fake when STRIPE_SECRET_KEY is unset', () => {
    const fake = new FakeStripeClient(cfg({}));
    expect(factory(cfg({}), fake)).toBe(fake);
  });

  it('injects StripeHttpClient when STRIPE_SECRET_KEY and webhook secret are set', () => {
    const c = cfg({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: SECRET,
    });
    expect(factory(c, new FakeStripeClient(c))).toBeInstanceOf(
      StripeHttpClient,
    );
  });

  it('fails fast when STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing', () => {
    const c = cfg({ STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(() => factory(c, new FakeStripeClient(c))).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });
});
