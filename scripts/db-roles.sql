-- Story 20.1 (AC12, A90): least-privilege role for the application.
--
-- Two phases, because two different privileges are needed (Story 20.10, QA round 1):
--   role    CREATE/ALTER ROLE of the application role. Needs a superuser (or a role with CREATEROLE). The plain
--           owner created by docs/deployment.md 1.2 CANNOT do it ("permission denied to create role").
--   grants  CONNECT, USAGE, GRANTs and ALTER DEFAULT PRIVILEGES. Run it AS THE REAL OWNER of the tables (the role
--           that runs `prisma migrate`): default privileges are "for the tables created by that role".
--   all     both in one go (default; for a superuser that IS the owner, e.g. the docker-compose init script).
-- `pnpm db:roles` runs 'role' with DB_ROLES_ADMIN_URL and 'grants' with MIGRATE_DATABASE_URL. Idempotent: run it again
-- after a restore or after the first `prisma migrate deploy`; 'role' is a no-op when the role already has the
-- right attributes and no password is given (so a CREATEROLE admin never hits "permission denied to alter role",
-- which PostgreSQL 16+ raises when REPLICATION/BYPASSRLS are re-specified by a non-superuser). It never drops
-- anything and never touches other roles.
--
-- Parameters, as session settings (scripts/db-roles.mjs and deploy/db/init-roles.sql set them):
--   dbroles.env        environment name; the role is collectorsclub_<env>_app
--   dbroles.password   SCRAM-SHA-256 verifier of the password (required to CREATE the role; optional to
--                      rotate it). NEVER the clear text: if a statement fails Postgres logs its text
--                      (`CONTEXT: SQL statement "CREATE ROLE ... PASSWORD ..."`), and a clear
--                      password would end up in the server log. `pnpm db:roles` converts
--                      APP_DB_PASSWORD (scripts/scram-verifier.mjs); this file refuses clear text.
--   dbroles.owner      role whose FUTURE tables the app role gets privileges on (default: the current user; the
--                      script `pnpm db:roles` does SET ROLE to it when DB_ROLES_OWNER is given)
--   dbroles.phase      role | grants | all (default all)
--   dbroles.revoke_temp  'off' to keep the TEMPORARY privilege that PUBLIC has on the database by default.
--                      Anything else (the default) revokes it from PUBLIC: see "TEMPORARY" below.
--
-- The role: LOGIN, not SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, owns nothing.
-- It cannot run DDL, cannot ALTER/DISABLE a trigger and, for "Audit_Events", has
-- no UPDATE/DELETE/TRUNCATE (the REVOKE below; the migration also revokes them
-- from roles that existed when it ran). A superuser/DBA can still disable the
-- triggers and rewrite the chain (A91): the mitigation is the external anchor
-- of the chain head (docs/deployment.md 13).
--
-- TEMPORARY (Story 20.1, QA round 4): a role with TEMPORARY on the database can create
-- temporary tables/views/types, which Postgres searches before the real ones for any
-- statement that does not list `pg_temp` explicitly in its search_path. The trigger
-- functions list it LAST (migration 20261107100000), so a temporary table can no longer
-- stand in for "Audit_Events" or "Legal_Documents"; revoking TEMPORARY is the second layer:
-- the app role cannot create the decoy at all. The privilege comes from PUBLIC (the
-- default ACL of every database), so the REVOKE must be FROM PUBLIC: it also takes the
-- privilege from every other non-owner role of THIS database (superusers and the owner keep
-- it). The application does not use temporary tables (tested with the whole e2e suite
-- under the limited role). Pass dbroles.revoke_temp = 'off' (DB_ROLES_REVOKE_TEMP=off) if
-- another role of the database needs them, and GRANT TEMPORARY to that role instead.
DO $$
DECLARE
  env        text := current_setting('dbroles.env', true);
  pw         text := current_setting('dbroles.password', true);
  app        text;
  phase      text := coalesce(nullif(current_setting('dbroles.phase', true), ''), 'all');
  r          pg_roles%ROWTYPE;
BEGIN
  IF env IS NULL OR env !~ '^[a-z0-9_]{1,30}$' THEN
    RAISE EXCEPTION 'dbroles.env must match [a-z0-9_]{1,30} (e.g. production, staging, dev)';
  END IF;
  app := format('collectorsclub_%s_app', env);
  IF pw IS NOT NULL AND pw <> '' AND pw NOT LIKE 'SCRAM-SHA-256$%' THEN
    RAISE EXCEPTION 'dbroles.password must be a SCRAM-SHA-256 verifier, not a clear-text password (use pnpm db:roles)';
  END IF;

  IF phase NOT IN ('role', 'grants', 'all') THEN
    RAISE EXCEPTION 'dbroles.phase must be role, grants or all';
  END IF;
  IF phase = 'grants' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
      RAISE EXCEPTION 'the role % does not exist yet: a superuser (or a role with CREATEROLE) must create it first (DB_ROLES_ADMIN_URL=... pnpm db:roles, or docs/deployment.md 13.3, step A)', app;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO r FROM pg_roles WHERE rolname = app;
  IF NOT FOUND THEN
    IF pw IS NULL OR pw = '' THEN
      RAISE EXCEPTION 'dbroles.password is required to create the role % (a new server or database does not have it yet: set APP_DB_PASSWORD; omit it only to re-run on a role that already exists)', app;
    END IF;
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      app, pw);
    RAISE NOTICE 'role % created', app;
  ELSE
    IF r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls THEN
      RAISE NOTICE 'role % exists with the right attributes', app;
    ELSE
      EXECUTE format(
        'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', app);
      RAISE NOTICE 'role % exists: attributes reset', app;
    END IF;
    IF pw IS NOT NULL AND pw <> '' THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', app, pw);
      RAISE NOTICE 'role % password rotated', app;
    ELSE
      RAISE NOTICE 'role % password unchanged', app;
    END IF;
  END IF;
END
$$;

DO $$
DECLARE
  env        text := current_setting('dbroles.env', true);
  owner_name text := coalesce(nullif(current_setting('dbroles.owner', true), ''), current_user);
  phase      text := coalesce(nullif(current_setting('dbroles.phase', true), ''), 'all');
  app        text;
  db         text := current_database();
BEGIN
  IF phase = 'role' THEN
    RETURN;
  END IF;
  IF env IS NULL OR env !~ '^[a-z0-9_]{1,30}$' THEN
    RAISE EXCEPTION 'dbroles.env must match [a-z0-9_]{1,30} (e.g. production, staging, dev)';
  END IF;
  app := format('collectorsclub_%s_app', env);
  IF owner_name <> current_user THEN
    RAISE EXCEPTION 'dbroles.owner (%) is not the current user (%): run the grants phase as the owner of the tables (pnpm db:roles does SET ROLE with DB_ROLES_OWNER)', owner_name, current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    RAISE EXCEPTION 'the role % does not exist', app;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, app);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app);
  IF coalesce(current_setting('dbroles.revoke_temp', true), 'on') <> 'off' THEN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', db);
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', db, app);
  END IF;
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
  -- The usage log (Story 20.7) is MUTABLE on purpose (rows are deleted by the 7-day purge and by the
  -- anonymization of an account) but it is only ever INSERTed, SELECTed and DELETEd: a row is never updated,
  -- so the blanket UPDATE above is taken back, and so are TRUNCATE (a whole-table wipe is the owner's) and the
  -- privileges the application has no use for.
  IF to_regclass('public."Usage_Logs"') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public."Usage_Logs" FROM %I', app);
  END IF;
  -- Prisma's own bookkeeping table is the migrator's.
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public."_prisma_migrations" FROM %I', app);
  END IF;
END
$$;
