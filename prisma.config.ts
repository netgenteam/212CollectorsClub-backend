// Prisma 7 CLI config (migrate/generate/studio). Runtime app config still
// goes exclusively through @nestjs/config (see src/prisma/prisma.service.ts) —
// this file only feeds the Prisma CLI itself, which needs DATABASE_URL for
// `prisma migrate dev|deploy` per AD-1.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Story 20.8 round 2: the CLI's session runs in UTC too (docs/deployment.md 21), whatever the database or the
 * role is set to; an `options` already in the URL (deploy.sh adds `-c lock_timeout=...`) is kept and extended.
 * Same rule as `src/prisma/db-session.ts` (not imported: this file is loaded by the Prisma CLI before any build).
 */
function utcSession(raw: string): string {
  try {
    const url = new URL(raw);
    const existing = (url.searchParams.get('options') ?? '').trim();
    if (/(^|\s)-c\s+timezone\s*=/i.test(existing)) return raw;
    url.searchParams.delete('options');
    const rest = url.searchParams.toString();
    url.search = '';
    // percent-encoded by hand: `searchParams.set` writes spaces as `+`
    return `${url.toString()}?${rest ? `${rest}&` : ''}options=${encodeURIComponent(`${existing} -c TimeZone=UTC`.trim())}`;
  } catch {
    return raw;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `tsx` runs the TS/ESM seed script directly (no separate build step),
    // resolving the generated Prisma client's nodenext ".js" specifiers
    // against their sibling ".ts" sources the way plain `node` cannot.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Story 20.1: migrations run as the database OWNER (MIGRATE_DATABASE_URL);
    // the application connects with the least-privilege role (DATABASE_URL).
    // Without MIGRATE_DATABASE_URL both are the same (dev, CI).
    url: utcSession(process.env.MIGRATE_DATABASE_URL || env('DATABASE_URL')),
  },
});
