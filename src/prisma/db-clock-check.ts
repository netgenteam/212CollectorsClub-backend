import type { Logger } from '@nestjs/common';

/** The parsed `now()` and the epoch of the same `now()` further apart than this: the session zone is not UTC. */
export const CLOCK_PARSE_TOLERANCE_MS = 1_000;

interface Queryable {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export interface DatabaseClockCheck {
  ok: boolean;
  /** Parsed `now()` minus the epoch of the same `now()`, in ms (0 when the driver reads instants correctly). */
  parseErrorMs: number;
  /** `current_setting('TimeZone')` of the connection that answered. */
  sessionZone: string;
}

/**
 * Reads `now()` BOTH ways in one statement (as a `timestamptz`, parsed by the driver, and as an epoch, which no
 * zone can change) and compares them. They differ exactly when the driver misreads `timestamptz`, which is
 * what a connection whose time zone is not UTC does (see `db-session.ts`). Pure of side effects.
 */
export async function readDatabaseClockCheck(
  db: Queryable,
): Promise<DatabaseClockCheck> {
  const rows = await db.$queryRawUnsafe<
    { n: Date; e: string | number | bigint; z: string }[]
  >(
    `SELECT now() AS n, (floor(extract(epoch FROM now()) * 1000))::bigint AS e, current_setting('TimeZone') AS z`,
  );
  const r = rows[0];
  const parseErrorMs = r.n.getTime() - Number(r.e);
  return {
    ok: Math.abs(parseErrorMs) <= CLOCK_PARSE_TOLERANCE_MS,
    parseErrorMs,
    sessionZone: r.z,
  };
}

/**
 * Boot check (docs/deployment.md 21): logs an ERROR (never throws, never blocks the start) when the application
 * connections are not reading instants correctly, which would silently shift audit timestamps, sessions,
 * reservations and the retention clock. The usual cause: a pooler between the app and Postgres that drops the
 * startup parameter `options=-c TimeZone=UTC`.
 */
export async function checkDatabaseClock(
  db: Queryable,
  logger: Pick<Logger, 'error' | 'warn' | 'log'>,
): Promise<DatabaseClockCheck | null> {
  try {
    const c = await readDatabaseClockCheck(db);
    if (!c.ok) {
      logger.error(
        `DATABASE CLOCK MISREAD: the driver parses now() ${Math.round(c.parseErrorMs / 1000)} s away from its epoch ` +
          `(session TimeZone=${c.sessionZone}). Every timestamptz read is shifted by that offset. The connection must run ` +
          `with TimeZone=UTC: the app sends it as a startup parameter ("options=-c TimeZone=UTC"); a pooler in ` +
          `transaction mode drops it. Fix: point DATABASE_URL at Postgres directly, or ALTER ROLE <app role> SET timezone = 'UTC' ` +
          `(docs/deployment.md section 21).`,
      );
    } else if (c.sessionZone.toUpperCase() !== 'UTC') {
      logger.warn(
        `database session TimeZone is ${c.sessionZone}, not UTC, but instants are read correctly`,
      );
    }
    return c;
  } catch (err) {
    logger.warn(
      `database clock check skipped: ${err instanceof Error ? err.name : 'error'}`,
    );
    return null;
  }
}
