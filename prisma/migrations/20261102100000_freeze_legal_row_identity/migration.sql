-- Story 19.1 fix (QA D2): the immutability triggers must also freeze row
-- identity. `legal_guard_rows` only looked at OLD."documentId", so a sandbox
-- document's version could be re-parented with
--   UPDATE "Legal_Document_Versions" SET "documentId" = <real>, "versionNumber" = 7
-- forging version 7 of a real document (same for Legal_Audit_Logs).
-- CREATE OR REPLACE keeps the triggers bound to the functions; the applied
-- migration is not edited.

CREATE OR REPLACE FUNCTION "legal_guard_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sandbox boolean;
BEGIN
  IF OLD."documentId" IS NOT NULL THEN
    SELECT "isSandbox" INTO sandbox FROM "Legal_Documents" WHERE "id" = OLD."documentId";
  END IF;
  IF COALESCE(sandbox, false) THEN
    -- Sandbox rows may be edited or deleted (test cleanup), but never moved:
    -- their identity (and so the document they belong to) is frozen.
    IF TG_OP = 'UPDATE' THEN
      IF NEW."id" IS DISTINCT FROM OLD."id"
         OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
         OR (TG_TABLE_NAME = 'Legal_Document_Versions'
             AND NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber") THEN
        RAISE EXCEPTION '% is immutable: id, documentId and versionNumber cannot be changed', TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is immutable: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- Real documents: besides slug/isSandbox, `kind` and `requiresAcceptance` are
-- fixed per slug (AD-88); nothing in the app changes them (title may change).
-- `id` is frozen for every document (children reference it).
CREATE OR REPLACE FUNCTION "legal_guard_documents"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSandbox" THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Legal_Documents: deleting a real document is rejected'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."slug" IS DISTINCT FROM OLD."slug"
     OR NEW."isSandbox" IS DISTINCT FROM OLD."isSandbox"
     OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'Legal_Documents: id, slug and isSandbox cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT OLD."isSandbox" AND (
       NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."requiresAcceptance" IS DISTINCT FROM OLD."requiresAcceptance") THEN
    RAISE EXCEPTION 'Legal_Documents: kind and requiresAcceptance of a real document cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
