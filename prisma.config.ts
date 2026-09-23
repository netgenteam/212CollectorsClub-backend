// Prisma 7 CLI config (migrate/generate/studio). Runtime app config still
// goes exclusively through @nestjs/config (see src/prisma/prisma.service.ts) —
// this file only feeds the Prisma CLI itself, which needs DATABASE_URL for
// `prisma migrate dev|deploy` per AD-1.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
