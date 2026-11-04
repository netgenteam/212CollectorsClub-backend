import pg from 'pg';
import type { AuditAction } from '../../src/audit/audit-actions.js';
import { adminDatabaseUrl } from './audit-sandbox.js';

/**
 * Story 20.5: makes every INSERT of ONE audit action fail, for real (a CHECK constraint added with
 * the owner's DDL on the disposable database), runs `run` and removes the constraint again. The
 * way to prove "if the audit write fails, X" without mocks and without touching the triggers.
 */
export async function blockAuditAction<T>(
  action: AuditAction,
  run: () => Promise<T>,
): Promise<T> {
  const u = new URL(adminDatabaseUrl());
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const name = `zz_block_${action.toLowerCase()}`.slice(0, 60);
  try {
    await c.query(
      `ALTER TABLE "Audit_Events" ADD CONSTRAINT "${name}" CHECK ("action" <> '${action}') NOT VALID`,
    );
    return await run();
  } finally {
    await c
      .query(`ALTER TABLE "Audit_Events" DROP CONSTRAINT IF EXISTS "${name}"`)
      .catch(() => undefined);
    await c.end();
  }
}
