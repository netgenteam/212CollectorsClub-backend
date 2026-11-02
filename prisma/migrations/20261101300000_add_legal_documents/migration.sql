-- CreateEnum
CREATE TYPE "LegalDocKind" AS ENUM ('TERMS', 'PRIVACY', 'COOKIES', 'SHIPPING', 'RETURNS', 'LEGAL_NOTICE');

-- CreateEnum
CREATE TYPE "LegalAuditAction" AS ENUM ('DRAFT_CREATED', 'DRAFT_EDITED', 'PUBLISHED', 'DRAFT_DISCARDED', 'RESTORED', 'IDENTITY_UPDATED');

-- CreateTable
CREATE TABLE "Legal_Documents" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "kind" "LegalDocKind" NOT NULL,
    "requiresAcceptance" BOOLEAN NOT NULL,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Legal_Documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Legal_Document_Versions" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "isSubstantial" BOOLEAN NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" UUID,
    "publishedByEmail" TEXT,
    "restoredFromVersion" INTEGER,

    CONSTRAINT "Legal_Document_Versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Legal_Drafts" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "baseVersionNumber" INTEGER,
    "restoredFromVersion" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "updatedByEmail" TEXT,

    CONSTRAINT "Legal_Drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Legal_Audit_Logs" (
    "id" UUID NOT NULL,
    "documentId" UUID,
    "action" "LegalAuditAction" NOT NULL,
    "adminUserId" UUID,
    "adminEmail" TEXT,
    "versionNumber" INTEGER,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Legal_Audit_Logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller_Identity_Settings" (
    "id" VARCHAR(32) NOT NULL,
    "legalName" TEXT,
    "rif" TEXT,
    "fiscalAddress" TEXT,
    "contactEmail" TEXT,
    "phone" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "Seller_Identity_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Legal_Documents_slug_key" ON "Legal_Documents"("slug");

-- CreateIndex
CREATE INDEX "Legal_Document_Versions_documentId_effectiveFrom_idx" ON "Legal_Document_Versions"("documentId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Legal_Document_Versions_documentId_versionNumber_key" ON "Legal_Document_Versions"("documentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Legal_Drafts_documentId_key" ON "Legal_Drafts"("documentId");

-- CreateIndex
CREATE INDEX "Legal_Audit_Logs_documentId_createdAt_idx" ON "Legal_Audit_Logs"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Legal_Document_Versions" ADD CONSTRAINT "Legal_Document_Versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Legal_Documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Legal_Drafts" ADD CONSTRAINT "Legal_Drafts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Legal_Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Legal_Audit_Logs" ADD CONSTRAINT "Legal_Audit_Logs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Legal_Documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Story 19.1 (AD-88): CHECKs ────────────────────────────────────────────
-- The six fixed slugs; sandbox documents (test helpers only) must be `e2e-*`.
ALTER TABLE "Legal_Documents" ADD CONSTRAINT "Legal_Documents_slug_check" CHECK (
  ("isSandbox" = false AND "slug" IN ('terminos', 'privacidad', 'cookies', 'envios', 'devoluciones', 'aviso-legal'))
  OR ("isSandbox" = true AND "slug" LIKE 'e2e-%')
);
ALTER TABLE "Legal_Document_Versions" ADD CONSTRAINT "Legal_Document_Versions_versionNumber_check" CHECK ("versionNumber" >= 1);
ALTER TABLE "Legal_Audit_Logs" ADD CONSTRAINT "Legal_Audit_Logs_meta_size_check" CHECK (octet_length("meta"::text) <= 2048);

-- ─── Immutability triggers (NFR-19.2, A81) ─────────────────────────────────
-- Row level: UPDATE/DELETE of a version or audit row is allowed ONLY when the
-- parent document is a sandbox one (`isSandbox`, creatable by test SQL only).
-- Statement level: TRUNCATE is always rejected.
CREATE FUNCTION "legal_guard_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sandbox boolean;
BEGIN
  IF OLD."documentId" IS NOT NULL THEN
    SELECT "isSandbox" INTO sandbox FROM "Legal_Documents" WHERE "id" = OLD."documentId";
  END IF;
  IF COALESCE(sandbox, false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION "legal_guard_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: TRUNCATE rejected', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION "legal_guard_documents"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSandbox" THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Legal_Documents: deleting a real document is rejected'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."slug" IS DISTINCT FROM OLD."slug" OR NEW."isSandbox" IS DISTINCT FROM OLD."isSandbox" THEN
    RAISE EXCEPTION 'Legal_Documents: slug and isSandbox cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Legal_Document_Versions_immutable" BEFORE UPDATE OR DELETE ON "Legal_Document_Versions"
  FOR EACH ROW EXECUTE FUNCTION "legal_guard_rows"();
CREATE TRIGGER "Legal_Document_Versions_no_truncate" BEFORE TRUNCATE ON "Legal_Document_Versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "legal_guard_truncate"();
CREATE TRIGGER "Legal_Audit_Logs_immutable" BEFORE UPDATE OR DELETE ON "Legal_Audit_Logs"
  FOR EACH ROW EXECUTE FUNCTION "legal_guard_rows"();
CREATE TRIGGER "Legal_Audit_Logs_no_truncate" BEFORE TRUNCATE ON "Legal_Audit_Logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "legal_guard_truncate"();
CREATE TRIGGER "Legal_Documents_guard" BEFORE UPDATE OR DELETE ON "Legal_Documents"
  FOR EACH ROW EXECUTE FUNCTION "legal_guard_documents"();
-- TRUNCATE ... CASCADE on a referenced table would also wipe evidence.
CREATE TRIGGER "Legal_Documents_no_truncate" BEFORE TRUNCATE ON "Legal_Documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "legal_guard_truncate"();

-- ─── Seed rows (idempotent; the app works without running the seed) ────────
INSERT INTO "Legal_Documents" ("id", "slug", "title", "kind", "requiresAcceptance", "isSandbox") VALUES
  (gen_random_uuid(), 'terminos', 'Términos y Condiciones', 'TERMS', true, false),
  (gen_random_uuid(), 'privacidad', 'Política de Privacidad', 'PRIVACY', true, false),
  (gen_random_uuid(), 'cookies', 'Política de Cookies', 'COOKIES', false, false),
  (gen_random_uuid(), 'envios', 'Política de Envíos', 'SHIPPING', true, false),
  (gen_random_uuid(), 'devoluciones', 'Política de Devoluciones', 'RETURNS', true, false),
  (gen_random_uuid(), 'aviso-legal', 'Aviso Legal', 'LEGAL_NOTICE', false, false)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "Seller_Identity_Settings" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
