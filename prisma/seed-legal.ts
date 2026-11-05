// Story 19.9: seeds ONLY the six legal DRAFTS (AD-88/94, FR-110), nothing else.
//
// `pnpm prisma db seed` / `pnpm prisma:seed` (prisma/seed.ts) also inserts the
// mock catalog (31 products with fixed ids), a dev admin user, landing content
// and shipping agencies: never run it in production. This script is the one to
// run there (docs/deployment.md section 12.1). `deploy/deploy.sh` runs no seed.
//
// Idempotent and safe to run in parallel (see LegalSeedService): a document that
// already has a draft or any version is left untouched ("skipped"); it never
// publishes anything. Prints the outcome per slug and no connection string.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { withUtcSession } from '../src/prisma/db-session.js';
import {
  LegalSeedService,
  loadLegalSeedTemplates,
} from '../src/legal/legal-seed.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set — cannot seed the legal drafts.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(databaseUrl) }),
});

async function main(): Promise<void> {
  const templates = await loadLegalSeedTemplates(
    fileURLToPath(new URL('./seed-data/legal/', import.meta.url)),
  );
  const results = await new LegalSeedService(prisma).seedDrafts(templates);
  console.log(
    `Legal drafts: ${results.map((r) => `${r.slug}=${r.outcome}`).join(' ')}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      'Legal seed failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
