-- CreateEnum
CREATE TYPE "TcgSyncKind" AS ENUM ('NIGHTLY', 'INGEST');

-- CreateEnum
CREATE TYPE "TcgSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "Tcg_Sync_Runs" (
    "id" UUID NOT NULL,
    "kind" "TcgSyncKind" NOT NULL,
    "status" "TcgSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ,
    "requestsUsed" INTEGER NOT NULL DEFAULT 0,
    "cardsSynced" INTEGER NOT NULL DEFAULT 0,
    "productsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "quotaExhausted" BOOLEAN NOT NULL DEFAULT false,
    "bigVariations" JSONB,
    "summary" JSONB,

    CONSTRAINT "Tcg_Sync_Runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tcg_Sync_Runs_kind_startedAt_idx" ON "Tcg_Sync_Runs"("kind", "startedAt");

-- AD-58 lock: at most one RUNNING row (partial unique index, manual SQL —
-- Prisma cannot express it). A second INSERT with status RUNNING violates it.
CREATE UNIQUE INDEX "Tcg_Sync_Runs_single_running_idx" ON "Tcg_Sync_Runs"("status") WHERE "status" = 'RUNNING';
