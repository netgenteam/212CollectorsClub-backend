-- Story 19.4 (AD-92, FR-113): acceptance evidence for register / checkout /
-- re-accept. Additive only (NFR-19.1): one table, two enums, four NULLable
-- columns on "Orders" (historical orders keep NULL). No IP, user agent or
-- birth date is stored (A71, NFR-19.6).
-- A metadata-only ALTER must not queue behind a long transaction on the hot
-- "Orders" table and stall checkout: give up after 10 s instead.
SET LOCAL lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TERMS', 'PRIVACY', 'SHIPPING', 'RETURNS', 'AGE_DECLARATION', 'COOKIES');

-- CreateEnum
CREATE TYPE "ConsentContext" AS ENUM ('REGISTER', 'CHECKOUT', 'RE_ACCEPT');

-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "returnsVersion" INTEGER,
ADD COLUMN     "shippingVersion" INTEGER,
ADD COLUMN     "termsAcceptedAt" TIMESTAMPTZ(3),
ADD COLUMN     "termsVersion" INTEGER;

-- CreateTable
CREATE TABLE "Consent_Records" (
    "id" UUID NOT NULL,
    "customerId" UUID,
    "orderId" UUID,
    "type" "ConsentType" NOT NULL,
    "documentVersionId" UUID,
    "version" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "context" "ConsentContext" NOT NULL,

    CONSTRAINT "Consent_Records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Consent_Records_customerId_type_acceptedAt_idx" ON "Consent_Records"("customerId", "type", "acceptedAt" DESC);

-- CreateIndex
CREATE INDEX "Consent_Records_orderId_idx" ON "Consent_Records"("orderId");

-- CreateIndex
CREATE INDEX "Consent_Records_documentVersionId_idx" ON "Consent_Records"("documentVersionId");

-- AddForeignKey
ALTER TABLE "Consent_Records" ADD CONSTRAINT "Consent_Records_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent_Records" ADD CONSTRAINT "Consent_Records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent_Records" ADD CONSTRAINT "Consent_Records_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "Legal_Document_Versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity of the rows themselves ─────────────────────────────────────
-- version >= 1 needs a real document version; version = 0 (no document) is
-- only an AGE_DECLARATION made while TERMS had no current version. Nothing
-- can claim to have accepted a version that does not exist.
ALTER TABLE "Consent_Records" ADD CONSTRAINT "Consent_Records_version_chk" CHECK (
  ("documentVersionId" IS NOT NULL AND "version" >= 1)
  OR ("documentVersionId" IS NULL AND "version" = 0 AND "type" = 'AGE_DECLARATION')
);

-- INSERT: the version number and the document kind must match the row they
-- point at, and that version must already be in force (never a future one).
CREATE OR REPLACE FUNCTION "consent_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_number integer;
  v_from timestamptz;
  v_kind "LegalDocKind";
  expected "LegalDocKind";
BEGIN
  IF NEW."documentVersionId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT v."versionNumber", v."effectiveFrom", d."kind"
    INTO v_number, v_from, v_kind
    FROM "Legal_Document_Versions" v
    JOIN "Legal_Documents" d ON d."id" = v."documentId"
   WHERE v."id" = NEW."documentVersionId";
  expected := CASE NEW."type"
    WHEN 'TERMS' THEN 'TERMS'
    WHEN 'AGE_DECLARATION' THEN 'TERMS'
    WHEN 'PRIVACY' THEN 'PRIVACY'
    WHEN 'SHIPPING' THEN 'SHIPPING'
    WHEN 'RETURNS' THEN 'RETURNS'
    WHEN 'COOKIES' THEN 'COOKIES'
  END;
  IF v_number IS DISTINCT FROM NEW."version"
     OR v_kind IS DISTINCT FROM expected
     OR v_from > now() THEN
    RAISE EXCEPTION 'Consent_Records: % version % does not match an effective document version', NEW."type", NEW."version"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- UPDATE / DELETE: append-only. The ONLY accepted change is the FK `SetNull`
-- cascade (account or order removed): the row keeps its evidence and loses the
-- link. `pg_trigger_depth() > 1` means "fired from inside another trigger"
-- (the FK action), so a plain `UPDATE ... SET "customerId" = NULL` is rejected
-- and cannot be used to launder a row into a deletable one. DELETE is allowed
-- only for rows already orphaned (no customer and no order).
CREATE OR REPLACE FUNCTION "consent_guard_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
       AND NEW."id" = OLD."id"
       AND NEW."type" = OLD."type"
       AND NEW."documentVersionId" IS NOT DISTINCT FROM OLD."documentVersionId"
       AND NEW."version" = OLD."version"
       AND NEW."acceptedAt" = OLD."acceptedAt"
       AND NEW."context" = OLD."context"
       AND (NEW."customerId" IS NOT DISTINCT FROM OLD."customerId" OR NEW."customerId" IS NULL)
       AND (NEW."orderId" IS NOT DISTINCT FROM OLD."orderId" OR NEW."orderId" IS NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consent_Records is append-only: UPDATE rejected'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."customerId" IS NULL AND OLD."orderId" IS NULL THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Consent_Records is append-only: DELETE of a linked row rejected'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION "consent_guard_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Consent_Records is append-only: TRUNCATE rejected'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "Consent_Records_insert_guard" BEFORE INSERT ON "Consent_Records"
  FOR EACH ROW EXECUTE FUNCTION "consent_guard_insert"();
CREATE TRIGGER "Consent_Records_immutable" BEFORE UPDATE OR DELETE ON "Consent_Records"
  FOR EACH ROW EXECUTE FUNCTION "consent_guard_rows"();
CREATE TRIGGER "Consent_Records_no_truncate" BEFORE TRUNCATE ON "Consent_Records"
  FOR EACH STATEMENT EXECUTE FUNCTION "consent_guard_truncate"();
