BEGIN;
-- Story 20.1 (QA round 4, B1): `SET search_path FROM CURRENT` (migrations 20261106200000 and
-- 20261106210000) did NOT close the hijack of the trigger functions that it was meant to
-- close. Postgres searches the session's temporary schema (`pg_temp`) FIRST for relations
-- unless `pg_temp` is listed explicitly, and `FROM CURRENT` stores `"$user", public`. A role
-- that can run SQL and has TEMPORARY on the database (PUBLIC has it by default, so the
-- limited application role does) could do
--     CREATE TEMP TABLE "Audit_Events"(seq bigint, hash char(64), "occurredAt" timestamptz);
--     INSERT INTO pg_temp."Audit_Events" VALUES (<head + 49>, repeat('a', 64), now() - interval '10 s');
-- and then insert into the real table a row whose `seq`/`prevHash` match the FAKE head: the
-- chain guard read the temporary table. The same with a temporary copy of "Legal_Documents"
-- with "isSandbox" = true, which let `legal_guard_version_insert` accept a back-dated version.
--
-- Fix: every trigger function gets
--     SET search_path = pg_catalog, public, pg_temp
-- `pg_catalog` first (a built-in type, function or operator cannot be shadowed by anything in
-- `public`), the project schema next, and `pg_temp` explicitly LAST: from there it is still
-- searched for relations and types, but only after the real ones, so a temporary table with
-- the name of a real one is never reached. Functions and operators are never looked up in
-- `pg_temp` (only if schema-qualified, which no function body does).
--
-- The earlier migrations are already applied and their checksums cannot change, so the
-- comments there that call `FROM CURRENT` a hijack protection stay as written: THIS
-- migration is the one that does it. It touches no table and no data; ALTER FUNCTION only
-- changes the function's catalog row. It names `public` literally (every table of the
-- project is unqualified in `public`; docs/deployment.md 13.7). `test/helpers/audit-sandbox.ts`
-- rewrites it for the throwaway schema of the e2e suite and replays only the audit lines.
-- An undeclared `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds the wait.
ALTER FUNCTION "audit_events_immutable"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "audit_events_chain_guard"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "audit_normalize_ip"(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_guard_rows"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_guard_truncate"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_guard_documents"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_guard_version_insert"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_draft_revision_after_delete"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_draft_revision_before_insert"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_draft_revision_never_decreases"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "legal_floor_never_decreases"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "consent_guard_insert"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "consent_guard_rows"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "consent_guard_truncate"() SET search_path = pg_catalog, public, pg_temp;

COMMIT;
