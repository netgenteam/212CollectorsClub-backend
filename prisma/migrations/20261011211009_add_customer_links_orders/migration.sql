-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "customerId" UUID;

-- CreateIndex
CREATE INDEX "Orders_customerId_createdAt_idx" ON "Orders"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Orders" ADD CONSTRAINT "Orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
