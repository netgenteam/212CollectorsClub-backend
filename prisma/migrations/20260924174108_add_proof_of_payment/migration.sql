-- CreateTable
CREATE TABLE "Proof_Of_Payments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proof_Of_Payments_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Proof_Of_Payments" ADD CONSTRAINT "Proof_Of_Payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
