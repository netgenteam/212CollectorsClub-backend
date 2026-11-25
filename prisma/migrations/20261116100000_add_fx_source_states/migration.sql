BEGIN;
-- Story 22.2 (AD-110, FR-158): per-source attempt/error state for the three live FX sources.
-- Additive: no existing table or column is touched; no seed (rows are created by the refresh cycle).
--
-- ROLLBACK (manual; the cycle simply stops recording per-source state and the active source falls back
-- to the Fx_Rate_Settings singleton for its confirmation candidate):
--   DROP TABLE "Fx_Source_States";

-- CreateTable
CREATE TABLE "Fx_Source_States" (
    "source" "FxRateSource" NOT NULL,
    "lastAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMPTZ,
    "rejectedReading" JSONB,

    CONSTRAINT "Fx_Source_States_pkey" PRIMARY KEY ("source")
);

COMMIT;
