import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SANDBOX_PREFIX, adminDatabaseUrl } from './audit-sandbox.js';

/**
 * Story 20.1: no `audit_t_*` sandbox schema survives a run. A suite whose
 * `beforeAll` throws never reaches its `afterAll`, so cleanup cannot depend on
 * it. Before the run: drop sandboxes older than 3 hours (a killed run). After the
 * run: drop the ones this run created (their name carries `AUDIT_SANDBOX_RUN`,
 * exported here before the workers are forked). DROP SCHEMA only: nothing here
 * touches a trigger or a row.
 */
const STALE_SECONDS = 3 * 3600;

async function dropWhere(pred: (name: string) => boolean): Promise<string[]> {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const dropped: string[] = [];
  try {
    const r = await c.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'audit\\_t\\_%'`,
    );
    for (const { nspname } of r.rows) {
      if (!/^audit_t_[a-z0-9_]+$/.test(nspname) || !pred(nspname)) continue;
      await c.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
      dropped.push(nspname);
    }
  } finally {
    await c.end();
  }
  return dropped;
}

export default async function setup(): Promise<() => Promise<void>> {
  const run = randomBytes(4).toString('hex');
  process.env.AUDIT_SANDBOX_RUN = run;
  const now = Math.floor(Date.now() / 1000);
  await dropWhere((name) => {
    const at = parseInt(name.slice(SANDBOX_PREFIX.length).split('_')[0], 36);
    return Number.isFinite(at) && now - at > STALE_SECONDS;
  });
  return async () => {
    const left = await dropWhere((name) => name.includes(`_${run}_`));
    if (left.length > 0) {
      console.warn(
        `[audit sandbox] dropped ${left.length} leaked schema(s): ${left.join(', ')}`,
      );
    }
  };
}
