/**
 * Story 20.5: the e2e suite NEVER runs against the developer's database.
 *
 * `Audit_Events` is immutable (triggers + REVOKE), and from this story on nearly
 * every e2e (admin login, FX, vitrina, checkout, legal...) writes audit events. A row
 * written to the real development database could not be removed. So `pnpm test:e2e`
 * clones the configured database (`CREATE DATABASE ... TEMPLATE`) into a throw-away
 * `<name>_e2e_<epoch>_<rand>` database, points `DATABASE_URL` /
 * `MIGRATE_DATABASE_URL` of the run at it, and drops it afterwards (`DROP DATABASE`,
 * never a DELETE: the immutability triggers do not apply to dropping a database).
 */
export const E2E_DB_RE = /^([a-z0-9_]{1,30})_e2e_(\d{10})_([0-9a-f]{8})$/;

/** The database name of a connection string (no credentials involved). */
export function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Same connection string, other database. */
export function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

export const isThrowawayDbName = (name: string): boolean =>
  E2E_DB_RE.test(name);

/**
 * Throws unless `url` points at a throw-away e2e database. Run by every test file
 * (setup file) and by the global setup after the clone: a suite that reached the
 * real database would leave undeletable audit rows.
 */
export function assertThrowawayUrl(
  url: string | undefined,
  what: string,
): void {
  if (!url) throw new Error(`${what} is not set`);
  const name = dbNameOf(url);
  if (!isThrowawayDbName(name)) {
    throw new Error(
      `${what} points at database "${name}", which is not a throw-away e2e database ` +
        `(<name>_e2e_<epoch>_<hex8>). The e2e suite must run through its global setup ` +
        `(test/helpers/global-test-db.ts); refusing to touch it.`,
    );
  }
}
