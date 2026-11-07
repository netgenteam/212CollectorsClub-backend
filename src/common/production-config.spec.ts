import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProductionConfigError,
  assertProductionConfig,
  isStripeEnabled,
  isSwaggerEnabled,
  productionConfigProblems,
} from './production-config.js';

/** Synthetic values only: random-looking, never a real credential. */
const GOOD: Record<string, string> = {
  NODE_ENV: 'production',
  COOKIE_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334',
  ADMIN_AUTH_SECRET: '0f9e8d7c6b5a4938271605f4e3d2c1b0aabbccdd',
  CUSTOMER_AUTH_SECRET: '5566778899aabbccddeeff00112233445566778a',
  STRIPE_SECRET_KEY: 'sk_' + 'live_SyntheticKey0123456789abcdef',
  STRIPE_WEBHOOK_SECRET: 'whsec_SyntheticSecret0123456789abcdef',
  LEGAL_REQUIRE_PUBLISHED: 'true',
};

function problemsWith(over: Record<string, string | undefined>): string[] {
  return productionConfigProblems({ ...GOOD, ...over });
}

describe('productionConfigProblems (Story 20.11)', () => {
  it('a complete, synthetic production environment is valid', () => {
    expect(productionConfigProblems(GOOD)).toEqual([]);
    expect(() => assertProductionConfig(GOOD)).not.toThrow();
  });

  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ['COOKIE_SECRET missing', { COOKIE_SECRET: undefined }, 'COOKIE_SECRET'],
    [
      'COOKIE_SECRET dev-only',
      { COOKIE_SECRET: 'dev-only-cart-cookie-secret-change-me' },
      'COOKIE_SECRET',
    ],
    ['COOKIE_SECRET short', { COOKIE_SECRET: 'abc123abc123' }, 'COOKIE_SECRET'],
    [
      'COOKIE_SECRET placeholder',
      { COOKIE_SECRET: 'please-change-me-to-something-long-enough-ok' },
      'COOKIE_SECRET',
    ],
    [
      'ADMIN_AUTH_SECRET missing',
      { ADMIN_AUTH_SECRET: undefined },
      'ADMIN_AUTH_SECRET',
    ],
    [
      'ADMIN_AUTH_SECRET dev-only',
      { ADMIN_AUTH_SECRET: 'dev-only-admin-jwt-secret-change-me' },
      'ADMIN_AUTH_SECRET',
    ],
    [
      'ADMIN_AUTH_SECRET short',
      { ADMIN_AUTH_SECRET: 'x'.repeat(31) },
      'ADMIN_AUTH_SECRET',
    ],
    [
      'CUSTOMER_AUTH_SECRET missing',
      { CUSTOMER_AUTH_SECRET: undefined },
      'CUSTOMER_AUTH_SECRET',
    ],
    [
      'CUSTOMER_AUTH_SECRET dev-only',
      { CUSTOMER_AUTH_SECRET: 'dev-only-customer-auth-secret-change-me' },
      'CUSTOMER_AUTH_SECRET',
    ],
    [
      'CUSTOMER_AUTH_SECRET short',
      { CUSTOMER_AUTH_SECRET: 'short' },
      'CUSTOMER_AUTH_SECRET',
    ],
    [
      'STRIPE_SECRET_KEY empty (fake client)',
      { STRIPE_SECRET_KEY: '' },
      'STRIPE_SECRET_KEY',
    ],
    [
      'STRIPE_SECRET_KEY test key',
      { STRIPE_SECRET_KEY: 'sk_test_SyntheticKey0123456789abcdef' },
      'STRIPE_SECRET_KEY',
    ],
    [
      'STRIPE_SECRET_KEY placeholder',
      { STRIPE_SECRET_KEY: 'sk_' + 'live_your_key_here_0123456789' },
      'STRIPE_SECRET_KEY',
    ],
    [
      'STRIPE_SECRET_KEY wrong shape',
      { STRIPE_SECRET_KEY: 'not-a-stripe-key-at-all-0123456789' },
      'STRIPE_SECRET_KEY',
    ],
    [
      'STRIPE_WEBHOOK_SECRET empty',
      { STRIPE_WEBHOOK_SECRET: '' },
      'STRIPE_WEBHOOK_SECRET',
    ],
    [
      'STRIPE_WEBHOOK_SECRET built-in fake',
      { STRIPE_WEBHOOK_SECRET: 'whsec_fake_test_secret' },
      'STRIPE_WEBHOOK_SECRET',
    ],
    [
      'STRIPE_WEBHOOK_SECRET wrong shape',
      { STRIPE_WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789' },
      'STRIPE_WEBHOOK_SECRET',
    ],
    ['STRIPE_ENABLED garbage', { STRIPE_ENABLED: 'maybe' }, 'STRIPE_ENABLED'],
    [
      'LEGAL_REQUIRE_PUBLISHED false',
      { LEGAL_REQUIRE_PUBLISHED: 'false' },
      'LEGAL_REQUIRE_PUBLISHED',
    ],
    [
      'LEGAL_REQUIRE_PUBLISHED unset',
      { LEGAL_REQUIRE_PUBLISHED: undefined },
      'LEGAL_REQUIRE_PUBLISHED',
    ],
  ];

  it.each(cases)(
    '%s fails and names only the variable',
    (_label, over, name) => {
      const problems = problemsWith(over);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.startsWith(name))).toBe(true);
      // No value of the environment (secret, key or the value that was wrong) is ever part of a message.
      const text = problems.join('\n');
      for (const v of [...Object.values(GOOD), ...Object.values(over)]) {
        if (v && v.length >= 8 && v !== 'production')
          expect(text).not.toContain(v);
      }
    },
  );

  it('two secrets with the same value are rejected', () => {
    const p = problemsWith({ CUSTOMER_AUTH_SECRET: GOOD.COOKIE_SECRET });
    expect(p.join(' ')).toContain('COOKIE_SECRET and CUSTOMER_AUTH_SECRET');
  });

  it('the legacy ADMIN_JWT_SECRET is checked when it is the one in use', () => {
    const ok = problemsWith({
      ADMIN_AUTH_SECRET: undefined,
      ADMIN_JWT_SECRET: GOOD.ADMIN_AUTH_SECRET,
    });
    expect(ok).toEqual([]);
    const bad = problemsWith({
      ADMIN_AUTH_SECRET: undefined,
      ADMIN_JWT_SECRET: 'dev-only-x',
    });
    expect(bad.some((p) => p.startsWith('ADMIN_JWT_SECRET'))).toBe(true);
  });

  it('STRIPE_ENABLED=false disables the rail explicitly and then no Stripe variable is required', () => {
    const p = problemsWith({
      STRIPE_ENABLED: 'false',
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(p).toEqual([]);
    expect(isStripeEnabled({ STRIPE_ENABLED: 'false' })).toBe(false);
    expect(isStripeEnabled({})).toBe(true);
  });

  it('STRIPE_ALLOW_TEST_KEYS=true admits a test-mode key (staging with NODE_ENV=production), never the fake webhook secret', () => {
    const test = {
      STRIPE_SECRET_KEY: 'sk_test_SyntheticKey0123456789abcdef',
      STRIPE_ALLOW_TEST_KEYS: 'true',
    };
    expect(problemsWith(test)).toEqual([]);
    expect(
      problemsWith({ ...test, STRIPE_WEBHOOK_SECRET: 'whsec_fake_test_secret' })
        .length,
    ).toBeGreaterThan(0);
  });

  it('reports every problem at once', () => {
    const p = productionConfigProblems({ NODE_ENV: 'production' });
    for (const name of [
      'COOKIE_SECRET',
      'ADMIN_AUTH_SECRET',
      'CUSTOMER_AUTH_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'LEGAL_REQUIRE_PUBLISHED',
    ]) {
      expect(p.some((x) => x.startsWith(name))).toBe(true);
    }
  });
});

describe('assertProductionConfig (Story 20.11)', () => {
  it('throws ProductionConfigError in production and lists the variables', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(
      ProductionConfigError,
    );
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(
      /COOKIE_SECRET/,
    );
  });

  it.each(['development', 'test', 'staging', undefined])(
    'does nothing with NODE_ENV=%s (dev and e2e keep their behavior)',
    (nodeEnv) => {
      expect(() => assertProductionConfig({ NODE_ENV: nodeEnv })).not.toThrow();
    },
  );

  it('main.ts runs the guard before Nest is created', () => {
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(src.indexOf('assertProductionConfig(process.env)')).toBeGreaterThan(
      0,
    );
    expect(src.indexOf('assertProductionConfig(process.env)')).toBeLessThan(
      src.indexOf('NestFactory.create'),
    );
  });
});

describe('isSwaggerEnabled (Story 20.11)', () => {
  it('is off in production unless SWAGGER_ENABLED=true; on elsewhere unless SWAGGER_ENABLED=false', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(
      isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
    ).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isSwaggerEnabled({})).toBe(true);
    expect(
      isSwaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }),
    ).toBe(false);
  });
});
