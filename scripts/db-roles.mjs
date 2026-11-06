// pnpm db:roles — creates/updates the least-privilege application role (Story 20.1, A90; two phases since 20.10).
//
//   DB_ROLES_ENV=production APP_DB_PASSWORD='...' DB_ROLES_ADMIN_URL='postgresql://postgres@...' pnpm db:roles
//
// Phase 1, "role" (CREATE/ALTER ROLE): needs a superuser or a role with CREATEROLE, which the plain owner of
//   docs/deployment.md 1.2 is NOT. It runs with DB_ROLES_ADMIN_URL. If that is not set and the owner connection
//   (below) is a superuser/CREATEROLE role, that connection does it; otherwise phase 1 is skipped and the role
//   must already exist (a re-run after a restore does not need an admin).
// Phase 2, "grants" (CONNECT, USAGE, GRANTs, ALTER DEFAULT PRIVILEGES): runs with MIGRATE_DATABASE_URL (falling
//   back to DATABASE_URL), the REAL OWNER of the tables, so the default privileges are the ones of the role that
//   runs the migrations. DB_ROLES_OWNER=<role> does SET ROLE to it when the connection is another role that can
//   (e.g. a superuser). Idempotent: run it again after a restore or after a deploy.
//
// APP_DB_PASSWORD is REQUIRED the first time (the role does not exist yet: a new server, a restore on another
// server); without it an existing role keeps its password. Rotating it needs phase 1 (an admin).
// DB_ROLES_REVOKE_TEMP=off keeps the TEMPORARY privilege of PUBLIC (see scripts/db-roles.sql).
//
// It prints the role name only: never a connection string or the password.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SCRAM_PREFIX, scramVerifier } from './scram-verifier.mjs';

const env = process.env.DB_ROLES_ENV;
// The server only ever sees a SCRAM-SHA-256 verifier, never the password: a failing
// CREATE/ALTER ROLE is written to the Postgres log with its text (Story 20.1, QA round 2).
const given = process.env.APP_DB_PASSWORD ?? '';
let password;
try {
  password = given === '' || given.startsWith(SCRAM_PREFIX) ? given : scramVerifier(given);
} catch (err) {
  console.error(`[db:roles] APP_DB_PASSWORD refused: ${err.message}`);
  process.exit(2);
}
const raw = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;

if (!env || !/^[a-z0-9_]{1,30}$/.test(env)) {
  console.error('DB_ROLES_ENV is required: the role will be collectorsclub_<env>_app (e.g. production, staging, dev).');
  process.exit(2);
}
if (!raw) {
  console.error('MIGRATE_DATABASE_URL (or DATABASE_URL) is not set.');
  process.exit(2);
}

function cleanUrl(r) {
  const u = new URL(r);
  u.searchParams.delete('schema'); // pg does not know Prisma's ?schema=
  return u.toString();
}
const url = new URL(cleanUrl(raw));
const adminRaw = process.env.DB_ROLES_ADMIN_URL || '';
const ownerRole = process.env.DB_ROLES_OWNER || '';
if (ownerRole && !/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(ownerRole)) {
  console.error('DB_ROLES_OWNER is not a plain role name.');
  process.exit(2);
}
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'db-roles.sql'), 'utf8');

// Story 20.8 round 3: every connection opens with the session time zone fixed to UTC (src/prisma/db-session.ts, which a
// plain .mjs cannot import: the same rule, written here; src/prisma/db-session-static.spec.ts checks the call site).
function withUtcSession(connectionString) {
  const u = new URL(connectionString);
  const existing = (u.searchParams.get('options') ?? '').trim();
  if (/(^|\s)-c\s+timezone\s*=/i.test(existing)) return connectionString;
  u.searchParams.delete('options');
  const rest = u.searchParams.toString();
  u.search = '';
  return `${u.toString()}?${rest ? `${rest}&` : ''}options=${encodeURIComponent(`${existing} -c TimeZone=UTC`.trim())}`;
}

function open(connectionString) {
  const c = new pg.Client({ connectionString: withUtcSession(connectionString) });
  c.on('notice', (n) => console.log(`[db:roles] ${n.message}`));
  return c;
}
const revokeTemp = process.env.DB_ROLES_REVOKE_TEMP === 'off' ? 'off' : 'on';
async function run(client, phase) {
  await client.query(
    `SELECT set_config('dbroles.env', $1, false), set_config('dbroles.password', $2, false), set_config('dbroles.owner', $5, false), set_config('dbroles.revoke_temp', $3, false), set_config('dbroles.phase', $4, false)`,
    [env, password, revokeTemp, phase, ownerRole && phase !== 'role' ? ownerRole : ''],
  );
  await client.query(sql);
}

let owner;
let admin;
try {
  owner = open(url.toString());
  await owner.connect();
  const me = (await owner.query('SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
  const ownerCanAdmin = Boolean(me?.rolsuper || me?.rolcreaterole);

  // Phase 1: the role itself.
  if (adminRaw) {
    admin = open(cleanUrl(adminRaw));
    await admin.connect();
    await run(admin, 'role');
    await admin.end();
    admin = undefined;
  } else if (ownerCanAdmin) {
    await run(owner, 'role');
  } else {
    const exists = (await owner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [`collectorsclub_${env}_app`])).rowCount > 0;
    if (!exists || password !== '') {
      throw new Error(
        `${exists ? 'rotating the password' : `creating the role collectorsclub_${env}_app`} needs a superuser or a role with CREATEROLE, and the owner connection is neither: set DB_ROLES_ADMIN_URL (docs/deployment.md 13.3 step A)`,
      );
    }
    console.log('[db:roles] role exists; phase 1 (CREATE/ALTER ROLE) skipped: no admin connection and no password to apply');
  }

  // Phase 2: the grants, as the real owner of the tables.
  if (ownerRole) await owner.query(`SET ROLE "${ownerRole}"`);
  await run(owner, 'grants');
  console.log(`[db:roles] done: collectorsclub_${env}_app on database ${(await owner.query('SELECT current_database() AS d')).rows[0].d}`);
} catch (err) {
  console.error(`[db:roles] failed: ${err.code ?? ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await owner?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
}
