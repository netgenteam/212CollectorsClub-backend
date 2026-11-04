BEGIN;
SET LOCAL lock_timeout = '10s';
-- Story 20.1 (QA round 3): same restore problem as 20261106200000_audit_restore_safe, for
-- the Epic 19 trigger functions. `pg_dump` sets an EMPTY search_path, so every function
-- that names a table without a schema ("Legal_Documents", "Consent_Records", ...) fails
-- in a `--data-only` restore with triggers active. Pinning the functions to the
-- search_path of this session (the one their table references already resolve against)
-- makes them independent of the caller. Behaviour is otherwise unchanged. Not part of the
-- audit sandbox (it only replays the audit migrations).
ALTER FUNCTION "legal_guard_rows"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_guard_truncate"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_guard_documents"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_guard_version_insert"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_draft_revision_after_delete"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_draft_revision_before_insert"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_draft_revision_never_decreases"() SET search_path FROM CURRENT;
ALTER FUNCTION "legal_floor_never_decreases"() SET search_path FROM CURRENT;
ALTER FUNCTION "consent_guard_insert"() SET search_path FROM CURRENT;
ALTER FUNCTION "consent_guard_rows"() SET search_path FROM CURRENT;
ALTER FUNCTION "consent_guard_truncate"() SET search_path FROM CURRENT;

COMMIT;
