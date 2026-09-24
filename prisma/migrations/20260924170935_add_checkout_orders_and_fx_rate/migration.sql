-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('PAGO_MOVIL', 'PAYPAL');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PAYMENT_PROCESSING', 'PENDING_VERIFICATION', 'PAID', 'PAYMENT_FAILED', 'PAYMENT_REJECTED', 'EXPIRED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderActorType" AS ENUM ('SYSTEM', 'PAYPAL_WEBHOOK', 'ADMIN', 'CRON');

-- CreateTable
CREATE TABLE "Fx_Rate_Settings" (
    "id" VARCHAR(32) NOT NULL,
    "vesPerUsd" DECIMAL(18,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fx_Rate_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Orders" (
    "id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "paymentRail" "PaymentRail" NOT NULL,
    "fulfillmentType" "FulfillmentType" NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "totalUsd" DECIMAL(10,2) NOT NULL,
    "fxRateVesPerUsd" DECIMAL(18,4),
    "totalVes" DECIMAL(14,2),
    "accessTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order_Lines" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "unitPriceUsd" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalUsd" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_Lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order_Status_History" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorType" "OrderActorType" NOT NULL,
    "adminUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_Status_History_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock_Holds" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stock_Holds_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Order_Lines" ADD CONSTRAINT "Order_Lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order_Lines" ADD CONSTRAINT "Order_Lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order_Status_History" ADD CONSTRAINT "Order_Status_History_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Holds" ADD CONSTRAINT "Stock_Holds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock_Holds" ADD CONSTRAINT "Stock_Holds_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
