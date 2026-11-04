-- Story 20.1 (AC12): mounted into /docker-entrypoint-initdb.d by docker-compose.yml.
-- It runs ONLY when Postgres initializes an EMPTY volume (as the superuser that
-- owns the database). An existing volume is covered by `pnpm db:roles`.
-- The password below is a LOCAL-DEV placeholder (the same spirit as
-- POSTGRES_PASSWORD in docker-compose.yml); staging/production use `pnpm db:roles`
-- with a real secret (docs/deployment.md 13).
SELECT set_config('dbroles.env', 'dev', false),
       set_config('dbroles.password', 'collectorsclub_dev_app_password', false),
       set_config('dbroles.owner', '', false);
\ir /opt/collectorsclub/db-roles.sql
