-- Story 20.1 (AC12, A90): least-privilege role for the application.
--
-- Run it as the OWNER/migrator of the database (`pnpm db:roles`, which reads
-- MIGRATE_DATABASE_URL, falling back to DATABASE_URL). Idempotent: run it again
-- after a restore, after the first `prisma migrate deploy`, or to rotate the
-- password. It never drops anything and never touches other roles.
--
-- Parameters, as session settings (scripts/db-roles.mjs and deploy/db/init-roles.sql set them):
--   dbroles.env        environment name; the role is collectorsclub_<env>_app
--   dbroles.password   SCRAM-SHA-256 verifier of the password (required to CREATE the role; optional to
--                      rotate it). NEVER the clear text: if a statement fails Postgres logs its text
--                      (`CONTEXT: SQL statement "CREATE ROLE ... PASSWORD ..."`), and a clear
--                      password would end up in the server log. `pnpm db:roles` converts
--                      APP_DB_PASSWORD (scripts/scram-verifier.mjs); this file refuses clear text.
--   dbroles.owner      role whose FUTURE tables the app role gets privileges on (default: the current user)
--
-- The role: LOGIN, not SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, owns nothing.
-- It cannot run DDL, cannot ALTER/DISABLE a trigger and, for "Audit_Events", has
-- no UPDATE/DELETE/TRUNCATE (the REVOKE below; the migration also revokes them
-- from roles that existed when it ran). A superuser/DBA can still disable the
-- triggers and rewrite the chain (A91): the mitigation is the external anchor
-- of the chain head (docs/deployment.md 13).
DO $$
DECLARE
  env        text := current_setting('dbroles.env', true);
  pw         text := current_setting('dbroles.password', true);
  owner_name text := coalesce(nullif(current_setting('dbroles.owner', true), ''), current_user);
  app        text;
  db         text := current_database();
BEGIN
  IF env IS NULL OR env !~ '^[a-z0-9_]{1,30}$' THEN
    RAISE EXCEPTION 'dbroles.env must match [a-z0-9_]{1,30} (e.g. production, staging, dev)';
  END IF;
  app := format('collectorsclub_%s_app', env);
  IF pw IS NOT NULL AND pw <> '' AND pw NOT LIKE 'SCRAM-SHA-256$%' THEN
    RAISE EXCEPTION 'dbroles.password must be a SCRAM-SHA-256 verifier, not a clear-text password (use pnpm db:roles)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    IF pw IS NULL OR pw = '' THEN
      RAISE EXCEPTION 'dbroles.password is required to create the role %', app;
    END IF;
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      app, pw);
    RAISE NOTICE 'role % created', app;
  ELSE
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', app);
    IF pw IS NOT NULL AND pw <> '' THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', app, pw);
      RAISE NOTICE 'role % exists: attributes reset, password rotated', app;
    ELSE
      RAISE NOTICE 'role % exists: attributes reset, password unchanged', app;
    END IF;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, app);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app);

  -- Tables/sequences that the owner's FUTURE migrations create: no manual GRANT needed.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    owner_name, app);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    owner_name, app);

  -- The audit log is append-only: the blanket grants above must not give the app UPDATE/DELETE/TRUNCATE on it.
  IF to_regclass('public."Audit_Events"') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public."Audit_Events" FROM %I', app);
  END IF;
  -- Prisma's own bookkeeping table is the migrator's.
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public."_prisma_migrations" FROM %I', app);
  END IF;
END
$$;
