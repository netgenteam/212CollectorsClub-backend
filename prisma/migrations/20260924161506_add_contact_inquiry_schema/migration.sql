-- CreateEnum
CREATE TYPE "ContactInquiryEmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Contact_Inquiries" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "productId" UUID,
    "emailStatus" "ContactInquiryEmailStatus" NOT NULL DEFAULT 'PENDING',
    "emailErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_Inquiries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Contact_Inquiries" ADD CONSTRAINT "Contact_Inquiries_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
