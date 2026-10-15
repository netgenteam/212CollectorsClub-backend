-- CreateEnum
CREATE TYPE "ProductLanguage" AS ENUM ('ES', 'EN', 'JP', 'CN', 'OTHER');

-- AlterTable
ALTER TABLE "Products" ADD COLUMN     "editionLanguage" "ProductLanguage" NOT NULL DEFAULT 'EN';

-- CreateIndex
CREATE INDEX "Products_editionLanguage_idx" ON "Products"("editionLanguage");
