import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Identifier of the database a globalSetup snapshot was taken from
 * (hash of DATABASE_URL + current_database()). Persisted in the abort
 * markers so a leftover marker is never restored into a different DB.
 */
export async function dbIdentity(c: pg.Client): Promise<string> {
  const r = await c.query<{ db: string }>(`SELECT current_database() AS db`);
  return createHash('sha256')
    .update(`${process.env.DATABASE_URL ?? ''}|${r.rows[0].db}`)
    .digest('hex');
}
