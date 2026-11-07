import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { stripeClientProvider } from './stripe-client.provider.js';
import { DisabledStripeClient } from './disabled-stripe-client.js';
import { StripeHttpClient } from './stripe-http-client.js';
import { StripeSignatureError } from './stripe-client.interface.js';
import type { FakeStripeClient } from './fake-stripe-client.js';

/** Story 20.11: production never gets the fake Stripe client. */
const fake = { name: 'fake' } as unknown as FakeStripeClient;
const config = (env: Record<string, string>) =>
  ({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => {
      if (!env[k]) throw new Error(`Configuration key "${k}" does not exist`);
      return env[k];
    },
  }) as unknown as ConfigService;
const build = (env: Record<string, string>) =>
  (
    stripeClientProvider as unknown as {
      useFactory: (c: ConfigService, f: FakeStripeClient) => unknown;
    }
  ).useFactory(config(env), fake);

describe('stripeClientProvider (Story 20.11)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('production without keys throws, naming the variables, and never returns the fake', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => build({})).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => build({})).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('production with the built-in fake webhook secret throws', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      build({
        STRIPE_SECRET_KEY: 'sk_' + 'live_SyntheticKey0123456789abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_fake_test_secret',
      }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('production with valid synthetic keys returns the real client', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      build({
        STRIPE_SECRET_KEY: 'sk_' + 'live_SyntheticKey0123456789abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_SyntheticSecret0123456789abcdef',
      }),
    ).toBeInstanceOf(StripeHttpClient);
  });

  it('STRIPE_ENABLED=false returns the disabled client even in production, without keys', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const c = build({ STRIPE_ENABLED: 'false' }) as DisabledStripeClient;
    expect(c).toBeInstanceOf(DisabledStripeClient);
    expect(c.disabled).toBe(true);
  });

  it('outside production the fake client is still the default', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(build({})).toBe(fake);
  });
});

describe('DisabledStripeClient (Story 20.11)', () => {
  it('createCheckoutSession rejects with 503 STRIPE_DISABLED and the webhook rejects everything', async () => {
    const c = new DisabledStripeClient();
    await expect(c.createCheckoutSession()).rejects.toMatchObject({
      status: 503,
    });
    expect(() => c.parseWebhook()).toThrow(StripeSignatureError);
  });
});
