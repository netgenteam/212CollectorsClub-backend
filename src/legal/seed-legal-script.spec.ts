import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 19.9: production must be able to seed ONLY the legal drafts. The full
 * seed (`prisma/seed.ts`) inserts the mock catalog with fixed ids and a dev
 * admin; `pnpm seed:legal` must never reach any of it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('pnpm seed:legal (Story 19.9)', () => {
  it('is a package script that runs prisma/seed-legal.ts', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['seed:legal']).toBe('tsx prisma/seed-legal.ts');
    expect(existsSync(resolve(ROOT, 'prisma/seed-legal.ts'))).toBe(true);
  });

  it('only seeds legal drafts: no catalog, admin, landing or shipping seed, and never publishes', () => {
    const src = read('prisma/seed-legal.ts');
    expect(src).toMatch(/seedDrafts\(/);
    expect(src).not.toMatch(
      /\.upsert\(|\.product\.|\.category\.|adminUser|landingConfig|shippingAgenc|seed-data\/(?!legal)/,
    );
    expect(src).not.toMatch(/\bpublishedAt\b|legalDocumentVersion/);
  });

  it('is documented in deployment.md as the production command and deploy.sh runs no seed', () => {
    const doc = read('docs/deployment.md');
    expect(doc).toMatch(/pnpm seed:legal/);
    expect(read('deploy/deploy.sh')).not.toMatch(/seed/i);
  });
});
