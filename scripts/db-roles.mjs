// pnpm db:roles — creates/updates the least-privilege application role (Story 20.1, A90).
//
//   DB_ROLES_ENV=production APP_DB_PASSWORD='...' pnpm db:roles
//
// Connects with MIGRATE_DATABASE_URL (the owner/migrator), falling back to
// DATABASE_URL. It runs scripts/db-roles.sql, which is idempotent. It prints the
// role name only: never the connection string or the password.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const env = process.env.DB_ROLES_ENV;
const password = process.env.APP_DB_PASSWORD ?? '';
const raw = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;

if (!env || !/^[a-z0-9_]{1,30}$/.test(env)) {
  console.error('DB_ROLES_ENV is required: the role will be collectorsclub_<env>_app (e.g. production, staging, dev).');
  process.exit(2);
}
if (!raw) {
  console.error('MIGRATE_DATABASE_URL (or DATABASE_URL) is not set.');
  process.exit(2);
}

const url = new URL(raw);
url.searchParams.delete('schema'); // pg does not know Prisma's ?schema=
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'db-roles.sql'), 'utf8');

const client = new pg.Client({ connectionString: url.toString() });
client.on('notice', (n) => console.log(`[db:roles] ${n.message}`));
try {
  await client.connect();
  await client.query(
    `SELECT set_config('dbroles.env', $1, false), set_config('dbroles.password', $2, false), set_config('dbroles.owner', '', false)`,
    [env, password],
  );
  await client.query(sql);
  console.log(`[db:roles] done: collectorsclub_${env}_app on database ${(await client.query('SELECT current_database() AS d')).rows[0].d}`);
} catch (err) {
  console.error(`[db:roles] failed: ${err.code ?? ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
