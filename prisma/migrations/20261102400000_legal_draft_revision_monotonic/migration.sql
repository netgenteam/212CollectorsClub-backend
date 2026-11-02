-- Story 19.2 (QA F): the draft `revision` must be monotonic per DOCUMENT and
-- never reused. Before, discarding (or publishing) a draft and creating a new
-- one started again at revision 1, so `publish { expectedRevision: 1 }` from an
-- admin who had seen the OLD draft 1 matched a NEW draft 1 with other text (ABA).
--
-- "draftRevisionFloor" is the highest revision any draft of the document ever
-- reached (0 = never had one). Enforced in the database so no code path can
-- forget it:
--   * AFTER DELETE on Legal_Drafts (discard, publish, cascade) raises the floor
--     to the revision the deleted draft had;
--   * BEFORE INSERT on Legal_Drafts forces revision = floor + 1, whatever the
--     caller wrote (the first draft of a document is still revision 1).
-- Edits keep using "revision" = "revision" + 1 under the draft row lock.
-- Existing rows are untouched: the floor starts at 0 and a live draft already
-- holds its own revision (a future delete raises the floor to it).

ALTER TABLE "Legal_Documents" ADD COLUMN "draftRevisionFloor" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION "legal_draft_revision_after_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Legal_Documents"
     SET "draftRevisionFloor" = greatest("draftRevisionFloor", OLD."revision")
   WHERE "id" = OLD."documentId";
  RETURN NULL;
END;
$$;

CREATE FUNCTION "legal_draft_revision_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_rev integer;
BEGIN
  SELECT "draftRevisionFloor" INTO floor_rev FROM "Legal_Documents"
   WHERE "id" = NEW."documentId" FOR UPDATE;
  NEW."revision" := COALESCE(floor_rev, 0) + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "legal_draft_revision_after_delete" AFTER DELETE ON "Legal_Drafts"
  FOR EACH ROW EXECUTE FUNCTION "legal_draft_revision_after_delete"();
CREATE TRIGGER "legal_draft_revision_before_insert" BEFORE INSERT ON "Legal_Drafts"
  FOR EACH ROW EXECUTE FUNCTION "legal_draft_revision_before_insert"();
