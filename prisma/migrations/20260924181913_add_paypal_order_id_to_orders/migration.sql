-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "paypalOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Orders_paypalOrderId_key" ON "Orders"("paypalOrderId");
