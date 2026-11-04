BEGIN;
-- Story 20.1 (observation of 19.2): with the application role a direct
-- UPDATE of "Legal_Drafts"."revision" or "Legal_Documents"."draftRevisionFloor"
-- to a LOWER value was not protected, and re-opens the ABA of the draft revision
-- (publish { expectedRevision } matching a different text).
--
-- Both only ever go up (edits use revision + 1; the existing triggers raise the
-- floor with greatest()). A decrease is rejected for every role except the
-- table OWNER (and superusers): migrations, DBAs and the e2e helpers that restore
-- real rows run as the owner; the application role (scripts/db-roles.sql) does not.
-- With the dev setup, where the app itself runs as owner, the guard is nominal
-- (docs/deployment.md 13).
--
-- This touches two existing tables (CREATE TRIGGER takes SHARE ROW EXCLUSIVE):
-- do not queue behind a long transaction. Inside the BEGIN/COMMIT of this file
-- SET LOCAL does take effect (verified on a clone, docs/deployment.md 13.3).
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION "legal_draft_revision_never_decreases"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT "relowner" FROM pg_class WHERE "oid" = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Legal_Drafts.revision never decreases (% -> %)', OLD."revision", NEW."revision"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION "legal_floor_never_decreases"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT "relowner" FROM pg_class WHERE "oid" = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Legal_Documents.draftRevisionFloor never decreases (% -> %)', OLD."draftRevisionFloor", NEW."draftRevisionFloor"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- WHEN: the function only runs for an actual decrease (no cost on normal edits).
CREATE TRIGGER "legal_draft_revision_never_decreases" BEFORE UPDATE OF "revision" ON "Legal_Drafts"
  FOR EACH ROW WHEN (NEW."revision" < OLD."revision")
  EXECUTE FUNCTION "legal_draft_revision_never_decreases"();
CREATE TRIGGER "legal_floor_never_decreases" BEFORE UPDATE OF "draftRevisionFloor" ON "Legal_Documents"
  FOR EACH ROW WHEN (NEW."draftRevisionFloor" < OLD."draftRevisionFloor")
  EXECUTE FUNCTION "legal_floor_never_decreases"();

COMMIT;
