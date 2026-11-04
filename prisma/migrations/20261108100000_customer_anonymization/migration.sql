BEGIN;
-- Story 20.6 (AD-98, FR-120..122): account anonymization from the admin.
-- 100 % additive and atomic (docs/deployment.md 12.3): two nullable columns on "Customers" and
-- an FK to "Admin_Users" with ON DELETE SET NULL. No row is rewritten (a NULL-default ADD COLUMN
-- is metadata only), nothing on "Orders", "Consent_Records" or any existing FK changes, and the
-- build that is running now ignores the columns. The lock wait is bounded by `deploy.sh`
-- (MIGRATE_LOCK_TIMEOUT_MS); this file sets no timeout of its own.
--
-- ORDER OF DEPLOYMENT: migrate BEFORE restarting. From this story on the checkout reads
-- "Customers"."anonymizedAt" (FOR SHARE) on every request with a session, with no
-- "does the column exist" probe: a new build started against an unmigrated database fails the
-- logged-in checkouts (closed, never open) until the migration is applied. `deploy.sh` already
-- migrates before it restarts.
ALTER TABLE "Customers"
  ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3),
  ADD COLUMN "anonymizedById" UUID;

ALTER TABLE "Customers"
  ADD CONSTRAINT "Customers_anonymizedById_fkey"
  FOREIGN KEY ("anonymizedById") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A row is "anonymized" only with its date; the admin may be NULL (SET NULL, or a script).
ALTER TABLE "Customers"
  ADD CONSTRAINT "Customers_anonymized_by_needs_at_check"
  CHECK ("anonymizedById" IS NULL OR "anonymizedAt" IS NOT NULL);

-- The anonymization is irreversible: once set, "anonymizedAt" can only stay as it is. The trigger
-- function pins its search_path like every other one of the project (pg_temp last).
CREATE FUNCTION customers_anonymized_at_is_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD."anonymizedAt" IS NOT NULL AND NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" THEN
    RAISE EXCEPTION 'Customers.anonymizedAt is final (account anonymization cannot be undone)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER customers_anonymized_at_is_final
  BEFORE UPDATE OF "anonymizedAt" ON "Customers"
  FOR EACH ROW EXECUTE FUNCTION customers_anonymized_at_is_final();
COMMIT;
