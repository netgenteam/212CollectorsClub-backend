-- CreateEnum
CREATE TYPE "FxSettingAction" AS ENUM ('SETTINGS_UPDATED', 'REJECTED_READING_ACCEPTED');

-- AlterTable (additive; the DEFAULT backfills existing rows with SETTINGS_UPDATED)
ALTER TABLE "Fx_Setting_Audits" ADD COLUMN "action" "FxSettingAction" NOT NULL DEFAULT 'SETTINGS_UPDATED';
