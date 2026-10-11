
-- AlterTable
ALTER TABLE "Carts" ADD COLUMN     "customerId" UUID;

-- AlterTable
ALTER TABLE "Wishlists" ADD COLUMN     "customerId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Carts_customerId_key" ON "Carts"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlists_customerId_key" ON "Wishlists"("customerId");

-- AddForeignKey
ALTER TABLE "Carts" ADD CONSTRAINT "Carts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlists" ADD CONSTRAINT "Wishlists_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

