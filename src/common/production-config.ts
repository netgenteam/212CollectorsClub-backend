/**
 * Story 20.11 (security audit, high priority 1): with `NODE_ENV=production` the service FAILS CLOSED at boot
 * when a secret or a switch still has a development value. Outside production nothing changes (dev and the e2e
 * suites, which run with `NODE_ENV=test`, keep their fake Stripe client and short secrets).
 *
 * Every message names the VARIABLE and the RULE it breaks and never prints a value (a secret in a log is a leak).
 * The same function runs in three places: `main.ts` (before Nest is created), `deploy/deploy.sh` through
 * `cli/check-production-config.ts` (before the migration and the restart) and the unit tests.
 */

/** Minimum length of every signing secret (`openssl rand -hex 24` gives 48). */
export const MIN_SECRET_LENGTH = 32;

/** Secrets that fall back to a `dev-only-*` value in `.env.example` and must never reach production. */
const SIGNING_SECRETS = [
  'COOKIE_SECRET',
  'ADMIN_AUTH_SECRET',
  'CUSTOMER_AUTH_SECRET',
] as const;

/** Values shipped in the repo (`.env.example`, the code): equal to one of them = a published secret. */
export const KNOWN_DEFAULT_SECRETS: readonly string[] = [
  'dev-only-cart-cookie-secret-change-me',
  'dev-only-admin-jwt-secret-change-me',
  'dev-only-customer-auth-secret-change-me',
  'ci-only-cookie-secret',
  'ci-only-admin-auth-secret',
  'ci-only-customer-auth-secret',
];

/** The webhook secret `FakeStripeClient` uses when none is configured. */
const KNOWN_DEFAULT_WEBHOOK_SECRETS: readonly string[] = [
  'whsec_fake_test_secret',
];

const PLACEHOLDER_WORDS =
  /(change-?me|changeit|placeholder|example|dummy|fake|replace|your[-_]|xxxx|todo|secret-here|<[^>]*>)/i;

type Env = Record<string, string | undefined>;

function trimmed(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/** `true` unless STRIPE_ENABLED is exactly `false` (case-insensitive): the explicit opt-out of the Stripe rail. */
export function isStripeEnabled(env: Env): boolean {
  return trimmed(env, 'STRIPE_ENABLED').toLowerCase() !== 'false';
}

function secretProblem(name: string, value: string): string | null {
  if (value === '') return `${name} is empty or not set`;
  if (/^dev-only/i.test(value)) {
    return `${name} still has a dev-only value (it must be a long random secret, e.g. \`openssl rand -hex 24\`)`;
  }
  if (KNOWN_DEFAULT_SECRETS.includes(value)) {
    return `${name} equals a default value published in the repository`;
  }
  if (PLACEHOLDER_WORDS.test(value)) {
    return `${name} looks like a placeholder, not a random secret`;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} is shorter than ${MIN_SECRET_LENGTH} characters (use \`openssl rand -hex 24\`)`;
  }
  return null;
}

/** The problems of the Stripe settings, or `[]` (also when the rail is explicitly off). */
export function stripeProblems(env: Env): string[] {
  const raw = trimmed(env, 'STRIPE_ENABLED').toLowerCase();
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    return ['STRIPE_ENABLED must be exactly `true` or `false` when set'];
  }
  if (!isStripeEnabled(env)) return [];
  const out: string[] = [];
  const allowTest =
    trimmed(env, 'STRIPE_ALLOW_TEST_KEYS').toLowerCase() === 'true';
  const key = trimmed(env, 'STRIPE_SECRET_KEY');
  if (key === '') {
    out.push(
      'STRIPE_SECRET_KEY is empty or not set (production never runs on the fake Stripe client; set a live key or disable the rail on purpose with STRIPE_ENABLED=false)',
    );
  } else if (PLACEHOLDER_WORDS.test(key)) {
    out.push('STRIPE_SECRET_KEY looks like a placeholder, not a Stripe key');
  } else if (/^(sk|rk)_test_/.test(key)) {
    if (!allowTest) {
      out.push(
        'STRIPE_SECRET_KEY is a TEST-mode key (sk_test_/rk_test_): use a live key, or set STRIPE_ALLOW_TEST_KEYS=true on a staging that runs with NODE_ENV=production',
      );
    }
  } else if (!/^(sk|rk)_live_[A-Za-z0-9_]{8,}$/.test(key)) {
    out.push(
      'STRIPE_SECRET_KEY does not look like a Stripe secret key (it must start with sk_live_ or rk_live_)',
    );
  }
  const whsec = trimmed(env, 'STRIPE_WEBHOOK_SECRET');
  if (whsec === '') {
    out.push(
      'STRIPE_WEBHOOK_SECRET is empty or not set (without it the webhook would be verified with the built-in test secret)',
    );
  } else if (
    KNOWN_DEFAULT_WEBHOOK_SECRETS.includes(whsec) ||
    PLACEHOLDER_WORDS.test(whsec)
  ) {
    out.push(
      'STRIPE_WEBHOOK_SECRET is the built-in test secret or a placeholder (copy the whsec_... of the real endpoint from the Stripe dashboard)',
    );
  } else if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(whsec)) {
    out.push(
      'STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret (it must start with whsec_)',
    );
  }
  return out;
}

/** Everything wrong with a production environment; `[]` = good to go. Pure: takes the variables, prints nothing. */
export function productionConfigProblems(env: Env): string[] {
  const out: string[] = [];
  const values: Record<string, string> = {};
  for (const name of SIGNING_SECRETS) {
    let v = trimmed(env, name);
    let label: string = name;
    // The admin secret may still come from the pre-12.2 name (auth-core.module.ts).
    if (name === 'ADMIN_AUTH_SECRET' && v === '') {
      v = trimmed(env, 'ADMIN_JWT_SECRET');
      if (v !== '')
        label = 'ADMIN_JWT_SECRET (legacy name of ADMIN_AUTH_SECRET)';
    }
    const p = secretProblem(label, v);
    if (p) out.push(p);
    else values[name] = v;
  }
  const names = Object.keys(values);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (values[names[i]] === values[names[j]]) {
        out.push(
          `${names[i]} and ${names[j]} have the same value (each one must be its own random secret)`,
        );
      }
    }
  }
  out.push(...stripeProblems(env));
  if (trimmed(env, 'LEGAL_REQUIRE_PUBLISHED') !== 'true') {
    out.push(
      'LEGAL_REQUIRE_PUBLISHED must be exactly `true` in production (with false the checkout and the sign-up record no acceptance of the legal texts)',
    );
  }
  return out;
}

export class ProductionConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Refusing to start with NODE_ENV=production: ${problems.length} configuration problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'ProductionConfigError';
  }
}

/** Throws `ProductionConfigError` when `NODE_ENV=production` and something is wrong; a no-op otherwise. */
export function assertProductionConfig(env: Env = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems = productionConfigProblems(env);
  if (problems.length > 0) throw new ProductionConfigError(problems);
}

/** `SWAGGER_ENABLED=true` is the only way to mount the API docs in production; off outside it only when set to `false`. */
export function isSwaggerEnabled(env: Env = process.env): boolean {
  const v = trimmed(env, 'SWAGGER_ENABLED').toLowerCase();
  if (env.NODE_ENV === 'production') return v === 'true';
  return v !== 'false';
}
