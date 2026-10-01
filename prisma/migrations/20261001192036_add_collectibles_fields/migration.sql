-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Franchise" ADD VALUE 'TOPPS';
ALTER TYPE "Franchise" ADD VALUE 'NARUTO';

-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'ACCESSORY';

-- AlterTable
ALTER TABLE "Products" ADD COLUMN     "certNumber" VARCHAR(50),
ADD COLUMN     "gradeValue" VARCHAR(20),
ADD COLUMN     "gradingCompany" VARCHAR(10),
ADD COLUMN     "isPreorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "releaseDate" TIMESTAMPTZ;
