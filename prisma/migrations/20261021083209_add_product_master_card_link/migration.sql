-- AlterTable
ALTER TABLE "Products" ADD COLUMN     "autoSyncPrice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastMarketSyncAt" TIMESTAMPTZ,
ADD COLUMN     "masterCardId" UUID;

-- CreateIndex
CREATE INDEX "Products_masterCardId_idx" ON "Products"("masterCardId");

-- AddForeignKey
ALTER TABLE "Products" ADD CONSTRAINT "Products_masterCardId_fkey" FOREIGN KEY ("masterCardId") REFERENCES "Master_Cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
