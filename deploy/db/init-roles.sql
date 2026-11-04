-- Story 20.1 (AC12): mounted into /docker-entrypoint-initdb.d by docker-compose.yml.
-- It runs ONLY when Postgres initializes an EMPTY volume (as the superuser that
-- owns the database). An existing volume is covered by `pnpm db:roles`.
-- The role gets the password `collectorsclub_dev_app_password`, a LOCAL-DEV
-- placeholder (the same spirit as POSTGRES_PASSWORD in docker-compose.yml). It is
-- given as a SCRAM-SHA-256 verifier, never in clear: a failing statement is
-- written to the Postgres log with its text. Regenerate with
--   printf '%s' 'the-password' | node scripts/scram-verifier.mjs
-- WARNING: this password is in the repository. Never use it (or the one in
-- docker-compose.yml) outside local development. Staging/production use
-- `pnpm db:roles` with a real secret (docs/deployment.md 13).
SELECT set_config('dbroles.env', 'dev', false),
       set_config('dbroles.password', 'SCRAM-SHA-256$4096:+jNDw01gRy048jfgnqWpfg==$Jj5HQJRnk/rFNXbNb4C9jWWeaMTPg88FWGTcwK3yc3g=:vUMP8Tvdz7i4zOw4jHm1ffvy5vTgBZnGcR30S1S1wps=', false),
       set_config('dbroles.owner', '', false);
\ir /opt/collectorsclub/db-roles.sql
