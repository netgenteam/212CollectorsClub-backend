-- CreateTable
CREATE TABLE "Master_Cards" (
    "id" UUID NOT NULL,
    "externalProvider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cleanName" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "franchise" "Franchise" NOT NULL,
    "gameSlug" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "setName" TEXT NOT NULL,
    "cardNumber" TEXT,
    "rarity" TEXT,
    "editionLanguage" "ProductLanguage" NOT NULL DEFAULT 'EN',
    "printing" TEXT,
    "tcgplayerId" INTEGER,
    "imageSmall" TEXT,
    "imageLarge" TEXT,
    "marketPriceUsd" DECIMAL(10,2),
    "lowPriceUsd" DECIMAL(10,2),
    "medianPriceUsd" DECIMAL(10,2),
    "priceAsOf" DATE,
    "rawApiData" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Master_Cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Master_Cards_searchText_idx" ON "Master_Cards" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Master_Cards_franchise_setId_idx" ON "Master_Cards"("franchise", "setId");

-- CreateIndex
CREATE INDEX "Master_Cards_setId_idx" ON "Master_Cards"("setId");

-- CreateIndex
CREATE UNIQUE INDEX "Master_Cards_externalProvider_externalId_key" ON "Master_Cards"("externalProvider", "externalId");
