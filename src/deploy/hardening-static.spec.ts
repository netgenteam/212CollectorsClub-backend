import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.11: static guards for the deployment artifacts (Dockerfile, deploy.sh, CI workflow, Nginx templates, .env.example).
 * Comments are stripped first so a rule that only appears in a comment does not count.
 */
const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const noComments = (s: string) => s.replace(/^\s*#.*$/gm, '');

describe('Dockerfile (Story 20.11)', () => {
  const code = noComments(read('Dockerfile'));
  it('pins the base image by digest', () => {
    expect(code).toMatch(/^FROM node:24-slim@sha256:[0-9a-f]{64}$/m);
  });
  it('runs as node, after creating uploads/ owned by node', () => {
    expect(code).toMatch(/^USER node$/m);
    expect(code).toMatch(/chown -R node:node uploads/);
    expect(code.indexOf('chown -R node:node uploads')).toBeLessThan(
      code.indexOf('USER node'),
    );
  });
  it('keeps the migration out of CMD and node as PID 1 (SIGTERM reaches it)', () => {
    const cmd = code.split('\n').find((l) => l.startsWith('CMD'));
    expect(cmd).toBe('CMD ["node", "dist/main"]');
    expect(cmd).not.toMatch(/prisma|sh/);
  });
});

describe('deploy.sh (Story 20.11)', () => {
  const code = noComments(read('deploy', 'deploy.sh'));
  it('requires the Stripe keys (unless STRIPE_ENABLED=false) and ADMIN_AUTH_SECRET', () => {
    expect(code).toMatch(
      /for var in CUSTOMER_AUTH_SECRET ADMIN_AUTH_SECRET; do/,
    );
    expect(code).toMatch(/STRIPE_ENABLED=/);
    expect(code).toMatch(
      /for var in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do/,
    );
  });
  it('validates the production rules before migrating and restarting', () => {
    const check = code.indexOf('check-production-config.js');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(code.indexOf('pnpm prisma:deploy'));
    expect(check).toBeLessThan(code.indexOf('systemctl restart'));
    expect(code).toMatch(/--as-production/);
  });
});

describe('CI workflow (Story 20.11)', () => {
  it('pins every action to a 40-hex commit SHA', () => {
    const uses = [
      ...read('.github', 'workflows', 'ci.yml').matchAll(/^\s*uses:\s*(\S+)/gm),
    ].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('Nginx templates (Story 20.11)', () => {
  for (const name of ['api.conf.template', 'staging-api.conf.template']) {
    it(`${name} serves TLS, redirects 80 to 443 and sends HSTS`, () => {
      const code = noComments(read('deploy', 'nginx', name));
      expect(code).toMatch(/listen 443 ssl;/);
      expect(code).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
      expect(code).toMatch(
        /add_header Strict-Transport-Security "max-age=\d+" always;/,
      );
      expect(code).toMatch(/ssl_certificate\s/);
    });
  }
});

describe('.env.example (Story 20.11)', () => {
  const env = read('.env.example');
  it('documents every variable the story adds', () => {
    for (const v of [
      'STRIPE_ENABLED',
      'STRIPE_ALLOW_TEST_KEYS',
      'SWAGGER_ENABLED',
    ])
      expect(env).toContain(v);
  });
});
