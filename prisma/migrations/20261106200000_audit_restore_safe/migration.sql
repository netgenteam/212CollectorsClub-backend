BEGIN;
SET LOCAL lock_timeout = '10s';
-- Story 20.1 (QA round 3): the audit triggers must survive a restore. Written so it can
-- also run inside the e2e sandbox schema (`search_path = audit_t_<rand>, public`): no
-- object is schema-qualified, the functions are pinned to the search_path of THIS
-- session (`SET search_path FROM CURRENT`), whatever schema it names.
--
-- 1. `pg_dump` writes `SELECT pg_catalog.set_config('search_path', '', false)` at the top
--    of every dump, so a trigger function that names `"Audit_Events"` without a schema
--    fails during a `--data-only` restore with triggers active:
--      ERROR: relation "Audit_Events" does not exist
--    A function with its own `search_path` setting ignores the session's, which makes
--    the trigger independent of who fires it (and closes the classic search_path
--    hijack of a trigger function). pg_dump keeps the setting in `CREATE FUNCTION`.
--
-- 2. The chain guard rejects an `occurredAt` older than the previous row. Rows written
--    before that rule (a clock that stepped back, up to 1.5 s in WSL2/VMs) may contain
--    such a pair legitimately: the hash chain does not look at time, so they verify OK,
--    but a `--data-only` restore replays them through the trigger and would fail. The
--    ONLY exception is an explicit restore session: the table owner (or a superuser)
--    sets `audit.allow_unordered_restore = on` (PGOPTIONS='-c audit.allow_unordered_restore=on').
--    The application role cannot use it (it does not own the table), and seq
--    continuity, prevHash and the future/ancient bounds stay enforced. After the
--    restore the chain MUST be verified (`POST /admin/audit/verify {mode:'full'}`).
CREATE OR REPLACE FUNCTION "audit_events_chain_guard"() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  last_seq  bigint;
  last_hash char(64);
  last_at   timestamptz;
  found_row boolean;
  restoring boolean;
BEGIN
  SELECT "seq", "hash", "occurredAt" INTO last_seq, last_hash, last_at
    FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1;
  found_row := FOUND;
  IF NOT found_row THEN
    IF NEW."seq" <> 1 OR NEW."prevHash" <> repeat('0', 64) THEN
      RAISE EXCEPTION 'Audit_Events chain must start at seq 1 with the genesis prevHash'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."seq" <> last_seq + 1 OR NEW."prevHash" <> last_hash THEN
    RAISE EXCEPTION 'Audit_Events chain fork or gap rejected (expected seq % after %)', last_seq + 1, last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF found_row AND NEW."occurredAt" < last_at THEN
    restoring := coalesce(current_setting('audit.allow_unordered_restore', true), '') = 'on'
      AND pg_has_role(current_user, (SELECT "relowner" FROM pg_catalog.pg_class WHERE "oid" = TG_RELID), 'USAGE');
    IF NOT restoring THEN
      RAISE EXCEPTION 'Audit_Events occurredAt % goes back before the previous row (%)', NEW."occurredAt", last_at
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."occurredAt" > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'Audit_Events occurredAt % is in the future', NEW."occurredAt"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."occurredAt" < timestamptz '2020-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'Audit_Events occurredAt % is implausibly old', NEW."occurredAt"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "audit_events_immutable"() SET search_path FROM CURRENT;
ALTER FUNCTION "audit_normalize_ip"(text) SET search_path FROM CURRENT;

COMMIT;
