import pg from 'pg';
import { Logger } from '@nestjs/common';
import { withUtcSession } from '../prisma/db-session.js';

/**
 * Story 20.8 (AD-101): the SESSION advisory lock of the retention run, held on a `pg.Client` of its own.
 *
 * Why not the Prisma pool: a session-level advisory lock belongs to ONE connection. On a pooled
 * connection the lock would stay with whichever request got that connection next (leaked, blocking every
 * run until the process restarts) and the run would think it still owned it after the pool moved on.
 * A dedicated client owns the lock for exactly as long as it lives: if the process dies, or the
 * connection drops, Postgres releases it by itself. `lost()` tells the run that this happened so it
 * stops at the next batch instead of purging without the guarantee (the unique partial index of
 * `Retention_Runs` is the second wall against two live runs).
 *
 * The client does nothing but hold the lock: it never runs a purge statement, so no statement can
 * queue behind another on it. `statement_timeout`/`query_timeout` keep the two calls it makes
 * (try-lock, unlock) from hanging.
 */
export class RetentionSessionLock {
  private static readonly logger = new Logger('RetentionLock');
  private isLost = false;
  private released = false;

  private constructor(private readonly client: pg.Client) {
    client.on('error', (err: Error) => {
      if (!this.released) {
        this.isLost = true;
        RetentionSessionLock.logger.error(
          `the retention lock connection failed (${err.name}); the run will stop at the next batch`,
        );
      }
    });
    client.on('end', () => {
      if (!this.released) this.isLost = true;
    });
  }

  /** Connection string for `pg`: Prisma's `?schema=` is not a libpq option. */
  static connectionString(databaseUrl: string): string {
    const url = new URL(databaseUrl);
    url.searchParams.delete('schema');
    // Story 20.8 round 2: same session time zone as the rest of the application (prisma/db-session.ts).
    return withUtcSession(url.toString());
  }

  /**
   * `null` when another session holds the lock (another instance, or another run of this one). Throws if
   * the database cannot be reached (the caller reports it; nothing was purged).
   */
  static async tryAcquire(
    databaseUrl: string,
    key: number,
  ): Promise<RetentionSessionLock | null> {
    const client = new pg.Client({
      connectionString: withUtcSession(
        RetentionSessionLock.connectionString(databaseUrl),
      ),
      application_name: 'retention-lock',
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      keepAlive: true,
    });
    // Attached before connecting: an 'error' event with no listener would crash the process.
    const lock = new RetentionSessionLock(client);
    try {
      await client.connect();
      const r = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1::int) AS ok',
        [key],
      );
      if (r.rows[0]?.ok !== true) {
        await lock.close();
        return null;
      }
      return lock;
    } catch (err) {
      await lock.close();
      throw err;
    }
  }

  /** The connection that carries the lock ended or failed: the lock is gone. */
  lost(): boolean {
    return this.isLost;
  }

  /** Name of the database the lock lives in (the guard checks it before anything is purged). */
  async currentDatabase(): Promise<string> {
    const r = await this.client.query<{ db: string }>(
      'SELECT current_database() AS db',
    );
    return r.rows[0].db;
  }

  async release(key: number): Promise<void> {
    if (!this.released && !this.isLost) {
      try {
        await this.client.query('SELECT pg_advisory_unlock($1::int)', [key]);
      } catch {
        /* closing the connection releases it anyway */
      }
    }
    await this.close();
  }

  private async close(): Promise<void> {
    this.released = true;
    try {
      await this.client.end();
    } catch {
      /* already closed */
    }
  }
}
