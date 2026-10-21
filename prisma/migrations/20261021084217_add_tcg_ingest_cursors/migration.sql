-- CreateEnum
CREATE TYPE "TcgIngestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "Tcg_Ingest_Cursors" (
    "id" UUID NOT NULL,
    "gameSlug" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "setName" TEXT NOT NULL,
    "setSlug" TEXT,
    "releaseDate" DATE,
    "cardCount" INTEGER,
    "nextPage" INTEGER NOT NULL DEFAULT 1,
    "status" "TcgIngestStatus" NOT NULL DEFAULT 'PENDING',
    "lastPriceSyncAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tcg_Ingest_Cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tcg_Ingest_Cursors_gameSlug_setId_key" ON "Tcg_Ingest_Cursors"("gameSlug", "setId");
