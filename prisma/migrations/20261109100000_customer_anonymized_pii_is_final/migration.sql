BEGIN;
-- Story 20.6 (QA round 2): the trigger of 20261108100000 only protected "anonymizedAt". With the
-- application's role, a direct UPDATE of an anonymized row could still hand back its email, name,
-- phone, image or emailVerified (a bug, a script, a stolen credential). Now the personal columns of
-- an anonymized row are final too: once "anonymizedAt" is set they can only keep their value.
--
-- Deliberately NOT protected: "updatedAt" and "anonymizedById". BetterAuth may touch "updatedAt" of a
-- user and the FK `ON DELETE SET NULL` of "anonymizedById" is itself an UPDATE of the row (verified by
-- test/customer-anonymize.e2e-spec.ts). Writing the SAME value is allowed (IS DISTINCT FROM): only a
-- change is refused. The anonymization itself runs while OLD."anonymizedAt" is still NULL, so it is
-- not affected.
--
-- 100 % metadata: it replaces one function body and one trigger definition; no row is read or
-- rewritten, nothing else changes. `CREATE OR REPLACE FUNCTION` keeps the SET clause only because it
-- is restated here (search_path pinned like every trigger function of the project, pg_temp last). An
-- undeclared `lock_timeout` is deliberate (docs/deployment.md 12.2): deploy.sh bounds the wait.
CREATE OR REPLACE FUNCTION customers_anonymized_at_is_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD."anonymizedAt" IS NOT NULL THEN
    IF NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" THEN
      RAISE EXCEPTION 'Customers.anonymizedAt is final (account anonymization cannot be undone)'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."email" IS DISTINCT FROM OLD."email"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."phone" IS DISTINCT FROM OLD."phone"
       OR NEW."image" IS DISTINCT FROM OLD."image"
       OR NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified" THEN
      RAISE EXCEPTION 'Customers row is anonymized: email, name, phone, image and emailVerified are final'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER customers_anonymized_at_is_final ON "Customers";
CREATE TRIGGER customers_anonymized_at_is_final
  BEFORE UPDATE OF "anonymizedAt", "email", "name", "phone", "image", "emailVerified" ON "Customers"
  FOR EACH ROW EXECUTE FUNCTION customers_anonymized_at_is_final();
COMMIT;
