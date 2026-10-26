-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('AGENCY_OFFICE', 'HOME_DELIVERY');

-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "agencyBranchCode" VARCHAR(50),
ADD COLUMN     "agencyBranchName" VARCHAR(150),
ADD COLUMN     "deliveryMode" "DeliveryMode",
ADD COLUMN     "municipality" VARCHAR(100),
ADD COLUMN     "parish" VARCHAR(100),
ADD COLUMN     "recipientIdDoc" VARCHAR(12),
ADD COLUMN     "referencePoint" VARCHAR(200),
ADD COLUMN     "shippingAgencyId" UUID,
ADD COLUMN     "trackingNumber" VARCHAR(64);

-- CreateTable
CREATE TABLE "Shipping_Agencies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "allowsOfficePickup" BOOLEAN NOT NULL DEFAULT true,
    "allowsHomeDelivery" BOOLEAN NOT NULL DEFAULT true,
    "trackingUrlTemplate" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipping_Agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipping_Branches" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "code" VARCHAR(50),
    "state" VARCHAR(100) NOT NULL,
    "municipality" VARCHAR(100) NOT NULL,
    "address" VARCHAR(200),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Shipping_Branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer_Addresses" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "label" VARCHAR(50),
    "recipientName" VARCHAR(200) NOT NULL,
    "recipientPhone" VARCHAR(20) NOT NULL,
    "recipientIdDoc" VARCHAR(12) NOT NULL,
    "deliveryMode" "DeliveryMode" NOT NULL,
    "agencyBranchName" VARCHAR(150),
    "agencyBranchCode" VARCHAR(50),
    "state" VARCHAR(100) NOT NULL,
    "municipality" VARCHAR(100) NOT NULL,
    "parish" VARCHAR(100),
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "referencePoint" VARCHAR(200),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_Addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order_Tracking_Events" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "adminUserId" UUID,
    "previousValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_Tracking_Events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shipping_Agencies_code_key" ON "Shipping_Agencies"("code");

-- CreateIndex
CREATE INDEX "Shipping_Agencies_isActive_sortOrder_idx" ON "Shipping_Agencies"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Shipping_Branches_agencyId_idx" ON "Shipping_Branches"("agencyId");

-- CreateIndex
CREATE INDEX "Customer_Addresses_customerId_createdAt_idx" ON "Customer_Addresses"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_Addresses_agencyId_idx" ON "Customer_Addresses"("agencyId");

-- CreateIndex
CREATE INDEX "Order_Tracking_Events_orderId_createdAt_idx" ON "Order_Tracking_Events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Orders_shippingAgencyId_idx" ON "Orders"("shippingAgencyId");

-- AddForeignKey
ALTER TABLE "Orders" ADD CONSTRAINT "Orders_shippingAgencyId_fkey" FOREIGN KEY ("shippingAgencyId") REFERENCES "Shipping_Agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipping_Branches" ADD CONSTRAINT "Shipping_Branches_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Shipping_Agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer_Addresses" ADD CONSTRAINT "Customer_Addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer_Addresses" ADD CONSTRAINT "Customer_Addresses_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Shipping_Agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order_Tracking_Events" ADD CONSTRAINT "Order_Tracking_Events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order_Tracking_Events" ADD CONSTRAINT "Order_Tracking_Events_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (Prisma cannot model partial indexes): one default address per customer.
CREATE UNIQUE INDEX "Customer_Addresses_customerId_default_key" ON "Customer_Addresses"("customerId") WHERE "isDefault";

-- Seed the national agencies (idempotent; trackingUrlTemplate stays NULL until an admin sets it).
INSERT INTO "Shipping_Agencies" ("id", "name", "code", "allowsOfficePickup", "allowsHomeDelivery", "sortOrder", "updatedAt") VALUES
  (gen_random_uuid(), 'MRW', 'mrw', true, true, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Zoom', 'zoom', true, true, 2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Tealca', 'tealca', true, true, 3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Domesa', 'domesa', true, false, 4, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
