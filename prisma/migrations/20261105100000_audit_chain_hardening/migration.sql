BEGIN;
SET LOCAL lock_timeout = '10s';
-- Story 20.1 (QA round 2): three hardening changes of the audit log. Written so it
-- can also run inside the e2e sandbox schema (`search_path = audit_t_<rand>, public`):
-- no object is schema-qualified.

-- 1. `audit_normalize_ip(text)`: the text as Postgres prints the address
--    (`host(inet)`), or NULL when it is not an address Postgres accepts. `isIP()` in
--    Node accepts `fe80::1%eth0` (a zone id) and `::inet` rejects it; a failed cast
--    ABORTS the audited transaction, so the cast is made here, inside an exception
--    block (a sub-transaction), and can never fail the caller.
CREATE FUNCTION "audit_normalize_ip"(raw text) RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF raw IS NULL OR position('/' IN raw) > 0 THEN
    RETURN NULL;
  END IF;
  RETURN host(raw::inet);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 2. The chain guard also bounds `occurredAt` (the application role can INSERT, so
--    it could plant 1990 or 2090; a 2090 row would make every honest event
--    "go backwards" and stop the audit log for good):
--      - never before the previous row (monotonic; equal is fine: one flush shares
--        one instant),
--      - never more than one minute ahead of the database clock,
--      - never before 2020 (the first row cannot be backdated).
--    No lower bound against now(): a restore (`pg_restore` with triggers) replays
--    old rows in order and must keep working.
CREATE OR REPLACE FUNCTION "audit_events_chain_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash char(64);
  last_at   timestamptz;
  found_row boolean;
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
    RAISE EXCEPTION 'Audit_Events occurredAt % goes back before the previous row (%)', NEW."occurredAt", last_at
      USING ERRCODE = 'integrity_constraint_violation';
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

-- 3. A verification that did not cover the chain from the genesis to its end
--    (`fromSeq` > 1, a `limit` that stopped early, an incremental run that trusts
--    the rows before its anchor) is PARTIAL, not a clean bill of health.
ALTER TABLE "Audit_Verifications" ADD COLUMN "partial" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Audit_Verifications" SET "partial" = true WHERE "fromSeq" > 1;

COMMIT;
