import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Story 20.1: sandbox schemas for the audit e2e. `Audit_Events` of the REAL
 * database is immutable (triggers + REVOKE): a test must never leave rows in it,
 * because they could not be deleted. So the suite applies the SQL of the
 * migration inside a throwaway schema `audit_t_<rand>` and points the code under
 * test at it through the connection's `search_path` (the audit code uses
 * unqualified table names). Dropping the schema (DROP, not DELETE) removes
 * everything. Nothing here disables a trigger (a static test forbids it): the
 * "tampered" sandbox is built WITHOUT the triggers, as a DBA who dropped them.
 *
 * Cleanup never depends on a suite's `afterAll`: a throw in `beforeAll` (the
 * app does not boot, a login fails) skips it. The name carries the creation time
 * and the id of the run (`AUDIT_SANDBOX_RUN`, set by `global-audit-sandbox.ts`
 * before the workers start), and that global setup/teardown drops this run's
 * schemas and any older than a few hours (a killed run). A failure inside
 * `createAuditSandbox` itself drops its own schema.
 *
 * Privileged steps (CREATE SCHEMA, tampering, CREATE ROLE) use
 * `MIGRATE_DATABASE_URL` (the owner) and fall back to `DATABASE_URL`: with the
 * limited application role as `DATABASE_URL` the suite keeps working.
 */
export const adminDatabaseUrl = (): string => {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
};

/** The same connection string with `search_path` = sandbox first, then public. */
export function urlWithSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema},public`);
  return u.toString();
}

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

export function auditMigrationSql(): string {
  const dir = readdirSync(MIGRATIONS).find((d) =>
    d.endsWith('_add_audit_events'),
  );
  if (!dir) throw new Error('add_audit_events migration not found');
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** The later migrations that change the audit objects (applied after the first one, in order). */
export function auditHardeningSql(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((d) => d.endsWith('_audit_chain_hardening'))
    .sort()
    .map((d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
}

/** The migration without its own BEGIN/COMMIT (to run inside a caller's transaction). */
export const withoutTransaction = (sql: string): string =>
  sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');

/** Table built as if a DBA had dropped the triggers (every CREATE TRIGGER removed). */
export const withoutTriggers = (sql: string): string =>
  sql.replace(/CREATE TRIGGER[^;]*;/g, '');

export const SANDBOX_PREFIX = 'audit_t_';

/** `audit_t_<epoch seconds, base 36>_<run id>_<random>`: a bare identifier, safe to quote. */
export function sandboxName(): string {
  const run = (process.env.AUDIT_SANDBOX_RUN ?? 'norun').replace(
    /[^a-z0-9]/g,
    '',
  );
  return `${SANDBOX_PREFIX}${Math.floor(Date.now() / 1000).toString(36)}_${run}_${randomBytes(4).toString('hex')}`;
}

export interface AuditSandbox {
  schema: string;
  /** Owner connection string whose `search_path` hits the sandbox (the code under test runs through it). */
  url: string;
  /** Run SQL as the owner inside the sandbox schema. */
  exec: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  drop: () => Promise<void>;
}

const clientUrl = (url: string): string => {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
};

export async function createAuditSandbox(
  opts: { noTriggers?: boolean; extraSql?: string } = {},
): Promise<AuditSandbox> {
  const schema = sandboxName();
  const admin = adminDatabaseUrl();
  const client = new pg.Client({ connectionString: clientUrl(admin) });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    let sql = auditMigrationSql();
    if (opts.noTriggers) sql = withoutTriggers(sql);
    await client.query(sql);
    for (const more of auditHardeningSql()) await client.query(more);
    if (opts.extraSql) await client.query(opts.extraSql);
  } catch (err) {
    await client
      .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => undefined);
    await client.end().catch(() => undefined);
    throw err;
  }
  let closed = false;
  return {
    schema,
    url: urlWithSearchPath(admin, schema),
    exec: async (q, params) =>
      (await client.query(q, params)).rows as Record<string, unknown>[],
    drop: async () => {
      if (closed) return;
      closed = true;
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    },
  };
}
