-- CreateEnum
CREATE TYPE "MarketProvider" AS ENUM ('CARDMARKET', 'PRICECHARTING', 'PSA_CERT', 'TCGPLAYER');

-- CreateTable
CREATE TABLE "Product_Market_References" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "provider" "MarketProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "suggestedPriceEur" DECIMAL(10,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Product_Market_References_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_Market_References_productId_provider_url_key" ON "Product_Market_References"("productId", "provider", "url");

-- AddForeignKey
ALTER TABLE "Product_Market_References" ADD CONSTRAINT "Product_Market_References_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
