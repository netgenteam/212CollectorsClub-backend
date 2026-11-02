-- Story 19.2 (QA 19.1 finding): `effectiveFrom` was not protected in the
-- database. The app role could insert a version with `infinity` (it would sort
-- as "current" for ever and, being immutable, never go away), or a date in the
-- past / out of order (AD-89 needs "highest versionNumber" == "current").
--
-- Replaces the body of the BEFORE INSERT guard of Story 19.1 (same trigger,
-- same advisory lock, same max+1 rule and DB-clock `publishedAt`) with three
-- more rules, all raised as integrity_constraint_violation (SQLSTATE 23000, the
-- code the service maps to a retryable 409):
--   * "effectiveFrom" must be finite;
--   * it must be >= the effectiveFrom of the previous version (monotonic);
--   * for a REAL document it must also be >= now() (transaction clock, the one
--     the publish service validates against in the same transaction; compared
--     at the millisecond precision of the column, which has already rounded the
--     value when the trigger sees it), so a version can never be back-dated
--     into force. Sandbox documents (test
--     helpers insert past dates) are exempt from this last rule only.

CREATE OR REPLACE FUNCTION "legal_guard_version_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected integer;
  prev_from timestamptz;
  sandbox boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('legal:version:' || NEW."documentId"::text, 0));
  SELECT COALESCE(max("versionNumber"), 0) + 1 INTO expected
    FROM "Legal_Document_Versions" WHERE "documentId" = NEW."documentId";
  IF NEW."versionNumber" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Legal_Document_Versions: versionNumber must be % (max + 1), got %', expected, NEW."versionNumber"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT isfinite(NEW."effectiveFrom") THEN
    RAISE EXCEPTION 'Legal_Document_Versions: effectiveFrom must be a finite timestamp'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "effectiveFrom" INTO prev_from FROM "Legal_Document_Versions"
    WHERE "documentId" = NEW."documentId" ORDER BY "versionNumber" DESC LIMIT 1;
  IF prev_from IS NOT NULL AND NEW."effectiveFrom" < prev_from THEN
    RAISE EXCEPTION 'Legal_Document_Versions: effectiveFrom must be >= the previous version (%), got %', prev_from, NEW."effectiveFrom"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "isSandbox" INTO sandbox FROM "Legal_Documents" WHERE "id" = NEW."documentId";
  IF NOT COALESCE(sandbox, false) AND NEW."effectiveFrom" < date_trunc('milliseconds', now()) THEN
    RAISE EXCEPTION 'Legal_Document_Versions: effectiveFrom must be >= now() for a real document, got %', NEW."effectiveFrom"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW."publishedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
