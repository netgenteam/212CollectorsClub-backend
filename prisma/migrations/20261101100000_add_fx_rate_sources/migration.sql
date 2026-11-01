-- CreateEnum
CREATE TYPE "FxRateSource" AS ENUM ('BCV_USD', 'BCV_EUR', 'PARALELO_USD', 'MANUAL');

-- AlterTable
ALTER TABLE "Fx_Rate_Settings" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMPTZ,
ADD COLUMN     "manualVesPerUsd" DECIMAL(18,4),
ADD COLUMN     "maxAgeHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "maxVariationPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
ADD COLUMN     "providerUpdatedAt" TIMESTAMPTZ,
ADD COLUMN     "rateFetchedAt" TIMESTAMPTZ,
ADD COLUMN     "rejectedReading" JSONB,
ADD COLUMN     "source" "FxRateSource" NOT NULL DEFAULT 'BCV_USD';

-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "fxRateSource" "FxRateSource";

-- CreateTable
CREATE TABLE "Fx_Rate_Snapshots" (
    "id" UUID NOT NULL,
    "source" "FxRateSource" NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "providerUpdatedAt" TIMESTAMPTZ NOT NULL,
    "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fx_Rate_Snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fx_Setting_Audits" (
    "id" UUID NOT NULL,
    "adminUserId" UUID,
    "fromSource" "FxRateSource" NOT NULL,
    "toSource" "FxRateSource" NOT NULL,
    "manualRate" DECIMAL(18,4),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fx_Setting_Audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Fx_Rate_Snapshots_source_fetchedAt_idx" ON "Fx_Rate_Snapshots"("source", "fetchedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Fx_Rate_Snapshots_source_providerUpdatedAt_key" ON "Fx_Rate_Snapshots"("source", "providerUpdatedAt");

-- CreateIndex
CREATE INDEX "Fx_Setting_Audits_createdAt_idx" ON "Fx_Setting_Audits"("createdAt");

-- AddForeignKey
ALTER TABLE "Fx_Setting_Audits" ADD CONSTRAINT "Fx_Setting_Audits_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing row must not be "stale" right after deploy (AD-78).
UPDATE "Fx_Rate_Settings" SET "rateFetchedAt" = "updatedAt" WHERE "rateFetchedAt" IS NULL;

-- Thresholds and manual-rate invariants enforced in the DB (AD-78).
ALTER TABLE "Fx_Rate_Settings" ADD CONSTRAINT "Fx_Rate_Settings_fx_config_check"
  CHECK ("maxAgeHours" > 0 AND "maxVariationPct" BETWEEN 1 AND 100 AND ("source" <> 'MANUAL' OR "manualVesPerUsd" > 0));
