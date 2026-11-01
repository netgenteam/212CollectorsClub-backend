-- CreateEnum
CREATE TYPE "VitrinaRunMode" AS ENUM ('RANKED', 'FALLBACK');

-- CreateTable
CREATE TABLE "Product_Daily_Stats" (
    "productId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "cartAdds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Product_Daily_Stats_pkey" PRIMARY KEY ("productId","day")
);

-- CreateTable
CREATE TABLE "Vitrina_Algorithm_Settings" (
    "id" VARCHAR(32) NOT NULL,
    "wSales" INTEGER NOT NULL DEFAULT 40,
    "wRevenue" INTEGER NOT NULL DEFAULT 15,
    "wVelocity" INTEGER NOT NULL DEFAULT 15,
    "wInterest" INTEGER NOT NULL DEFAULT 20,
    "wNovelty" INTEGER NOT NULL DEFAULT 10,
    "halfLifeDays" INTEGER NOT NULL DEFAULT 14,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "noveltyDays" INTEGER NOT NULL DEFAULT 21,
    "maxPerFranchise" INTEGER NOT NULL DEFAULT 4,
    "mmrLambda" DECIMAL(3,2) NOT NULL DEFAULT 0.35,
    "priorM" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "scarcityThreshold" INTEGER NOT NULL DEFAULT 3,
    "minSalesForRanking" INTEGER NOT NULL DEFAULT 5,
    "viewDayCap" INTEGER NOT NULL DEFAULT 30,
    "currentRunId" UUID,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "Vitrina_Algorithm_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vitrina_Algorithm_Audits" (
    "id" UUID NOT NULL,
    "adminUserId" UUID,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vitrina_Algorithm_Audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product_Score_Runs" (
    "id" UUID NOT NULL,
    "computedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "VitrinaRunMode" NOT NULL,
    "config" JSONB NOT NULL,
    "salesCount" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "Product_Score_Runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product_Scores" (
    "runId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DECIMAL(7,4) NOT NULL,
    "components" JSONB NOT NULL,
    "reason" TEXT,

    CONSTRAINT "Product_Scores_pkey" PRIMARY KEY ("runId","productId")
);

-- CreateIndex
CREATE INDEX "Product_Daily_Stats_day_idx" ON "Product_Daily_Stats"("day");

-- CreateIndex
CREATE INDEX "Vitrina_Algorithm_Audits_createdAt_idx" ON "Vitrina_Algorithm_Audits"("createdAt");

-- CreateIndex
CREATE INDEX "Product_Scores_runId_rank_idx" ON "Product_Scores"("runId", "rank");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_Lines_productId_createdAt_idx" ON "Order_Lines"("productId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Orders_status_createdAt_idx" ON "Orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Wishlist_Items_productId_createdAt_idx" ON "Wishlist_Items"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "Product_Daily_Stats" ADD CONSTRAINT "Product_Daily_Stats_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vitrina_Algorithm_Settings" ADD CONSTRAINT "Vitrina_Algorithm_Settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vitrina_Algorithm_Audits" ADD CONSTRAINT "Vitrina_Algorithm_Audits_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product_Scores" ADD CONSTRAINT "Product_Scores_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Product_Score_Runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product_Scores" ADD CONSTRAINT "Product_Scores_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Weights must add up to 100 and constants stay sane (AD-81).
ALTER TABLE "Vitrina_Algorithm_Settings" ADD CONSTRAINT "Vitrina_Algorithm_Settings_weights_sum_check"
  CHECK ("wSales" >= 0 AND "wRevenue" >= 0 AND "wVelocity" >= 0 AND "wInterest" >= 0 AND "wNovelty" >= 0
    AND "wSales" + "wRevenue" + "wVelocity" + "wInterest" + "wNovelty" = 100);

-- Idempotent seed of the singleton with the default weights (A63). The
-- production deploy does not run seed.ts, so the migration seeds it.
INSERT INTO "Vitrina_Algorithm_Settings" ("id", "updatedAt")
VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
