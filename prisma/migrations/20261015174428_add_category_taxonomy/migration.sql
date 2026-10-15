-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('ROOT', 'SUBCATEGORY');

-- CreateEnum
CREATE TYPE "CategoryDimension" AS ENUM ('FRANCHISE', 'SEALED_FORMAT', 'EDITION_LANGUAGE', 'SET_COLLECTION', 'CUSTOM');

-- AlterTable
ALTER TABLE "Categories" ADD COLUMN     "dimension" "CategoryDimension",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parentId" UUID,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "type" "CategoryType" NOT NULL DEFAULT 'ROOT';

-- CreateIndex
CREATE INDEX "Categories_parentId_idx" ON "Categories"("parentId");

-- CreateIndex
CREATE INDEX "Categories_dimension_isActive_idx" ON "Categories"("dimension", "isActive");

-- AddForeignKey
ALTER TABLE "Categories" ADD CONSTRAINT "Categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Story 13.2 (AD-33): safety net — the service gives the readable 400.
ALTER TABLE "Categories" ADD CONSTRAINT "Categories_root_no_dimension_parent_check"
  CHECK ("type" <> 'ROOT' OR ("dimension" IS NULL AND "parentId" IS NULL));
