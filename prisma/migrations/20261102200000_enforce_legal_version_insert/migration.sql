-- Story 19.1 fix (QA 19.1 attempt 3, D4): the app role could INSERT a version
-- into a REAL document with an arbitrary `versionNumber` and an old
-- `publishedAt`; once inserted it is immutable and becomes the current version
-- (the highest number with effectiveFrom <= now()), i.e. a forged legal
-- version that can never be removed. The UPDATE/DELETE triggers cannot see it.
--
-- BEFORE INSERT trigger on "Legal_Document_Versions":
--   * serializes publishers of the same document with a transaction-level
--     advisory lock (taken BEFORE reading max(), held until commit/rollback),
--     so two concurrent publishes cannot both compute the same number;
--   * REJECTS (integrity_constraint_violation) any versionNumber other than
--     max(versionNumber) + 1 for that document (1 for the first). A rejection,
--     not a silent renumbering: the caller (Story 19.2) has already referenced
--     the number in the audit/restoredFromVersion, and retries on a race;
--   * OVERWRITES "publishedAt" with the database clock (clock_timestamp(): the
--     moment of the insert, monotonic with the advisory-lock order), whatever
--     the client sent.
-- `effectiveFrom` is a business decision (scheduled versions) and stays free.
-- Applies to sandbox and real documents alike (sandbox rows are inserted in
-- order with the helper). The previous immutability triggers are untouched.
-- (DISABLE TRIGGER by the app role is Story 20.1's DB-role work, not here.)

CREATE OR REPLACE FUNCTION "legal_guard_version_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected integer;
BEGIN
  -- Lock key: the document id (hashtextextended, 64-bit), namespaced.
  PERFORM pg_advisory_xact_lock(hashtextextended('legal:version:' || NEW."documentId"::text, 0));
  SELECT COALESCE(max("versionNumber"), 0) + 1 INTO expected
    FROM "Legal_Document_Versions" WHERE "documentId" = NEW."documentId";
  IF NEW."versionNumber" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Legal_Document_Versions: versionNumber must be % (max + 1), got %', expected, NEW."versionNumber"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."publishedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Legal_Document_Versions_insert_guard" BEFORE INSERT ON "Legal_Document_Versions"
  FOR EACH ROW EXECUTE FUNCTION "legal_guard_version_insert"();
