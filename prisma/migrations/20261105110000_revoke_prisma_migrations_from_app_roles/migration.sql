BEGIN;
-- Story 20.1 (QA round 2): `_prisma_migrations` must not be writable by the
-- application role (docs/deployment.md 13.3). `scripts/db-roles.sql` revokes it
-- when the table already exists, but with the compose init on an EMPTY volume the
-- role is created BEFORE Prisma creates the table, and ALTER DEFAULT PRIVILEGES
-- then grants it DML like any other new table. Migrations run after the init, so
-- this one closes the gap: it revokes everything on the table from the
-- least-privilege roles that follow the db-roles naming (`collectorsclub_<env>_app`).
-- Other roles (QA, reporting) are not touched.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT "rolname" FROM pg_roles
     WHERE NOT "rolsuper" AND "rolname" ~ '^collectorsclub_[a-z0-9_]{1,30}_app$'
  LOOP
    EXECUTE format('REVOKE ALL ON public."_prisma_migrations" FROM %I', r."rolname");
  END LOOP;
END
$$;

COMMIT;
