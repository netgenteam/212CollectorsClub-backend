-- CreateTable
CREATE TABLE "Landing_Config_Entries" (
    "id" UUID NOT NULL,
    "section" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "Landing_Config_Entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Landing_Config_Entries_section_key_key" ON "Landing_Config_Entries"("section", "key");

-- AddForeignKey
ALTER TABLE "Landing_Config_Entries" ADD CONSTRAINT "Landing_Config_Entries_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
