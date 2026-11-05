/**
 * Story 20.8 (round 2): EVERY connection of the application runs with the session time zone fixed to UTC.
 *
 * Why: the Prisma driver adapter (`@prisma/adapter-pg`) parses a `timestamptz` it receives as TEXT
 * (`2026-11-05 01:00:03.784-05`) as if it were UTC and ignores the offset. With the database (or the role)
 * set to any other zone a `SELECT now()` came back shifted by the offset (measured: 18 000 s for
 * `America/New_York`), and so did every `timestamptz` column read through Prisma: audit `occurredAt` (and
 * therefore the hash it feeds), `effectiveFrom`, reservations, FX, sessions. A raw `pg.Client` reads the
 * instant correctly, because `pg` honours the offset. The `timestamp` (no zone) columns Prisma maps by default
 * are read as UTC by definition, so they also need the session in UTC for `DEFAULT now()` and for
 * `AT TIME ZONE` arithmetic to mean the same thing.
 *
 * The startup parameter (`options=-c TimeZone=UTC`) wins over `ALTER DATABASE ... SET timezone` and
 * `ALTER ROLE ... SET timezone`, costs no query and cannot be undone by a pooled connection's reuse. It is
 * applied to: the Prisma pool (`PrismaService`, `prisma/seed.ts`), the usage-log writer pool, the retention
 * lock `pg.Client`, and the Prisma CLI (`prisma.config.ts`, so `MIGRATE_DATABASE_URL`). Limitation (checked
 * at boot by `checkDatabaseClock`, docs/deployment.md 21): a pooler in transaction mode (pgbouncer) that
 * ignores startup parameters would silently undo it.
 */
export const SESSION_TIMEZONE_OPTION = '-c TimeZone=UTC';

/** `existing` options plus `extra` flags and the UTC time zone, once each (never duplicates the zone). */
export function sessionOptions(
  existing?: string | null,
  extra: string[] = [],
): string {
  const parts = [...(existing?.trim() ? [existing.trim()] : []), ...extra];
  const joined = parts.join(' ');
  return /(^|\s)-c\s+timezone\s*=/i.test(joined)
    ? joined
    : [joined, SESSION_TIMEZONE_OPTION].filter(Boolean).join(' ');
}

/**
 * The same connection string with `options` extended (an `options` already in the URL is kept and extended,
 * not replaced: `pg` lets the URL win over a config property).
 */
export function withUtcSession(
  connectionString: string,
  extra: string[] = [],
): string {
  const url = new URL(connectionString);
  const options = sessionOptions(url.searchParams.get('options'), extra);
  url.searchParams.delete('options');
  // Percent-encoded by hand (`%20`, `%3D`): `searchParams.set` would write spaces as `+`, which not every consumer
  // of the URL (the Prisma schema engine, for one) reads as a space.
  const rest = url.searchParams.toString();
  url.search = '';
  return `${url.toString()}?${rest ? `${rest}&` : ''}options=${encodeURIComponent(options)}`;
}
