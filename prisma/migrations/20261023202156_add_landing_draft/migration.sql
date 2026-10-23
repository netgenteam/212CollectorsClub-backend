-- AlterTable
ALTER TABLE "Landing_Config_Entries" ADD COLUMN     "draftUpdatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "draftUpdatedById" UUID,
ADD COLUMN     "draftValue" JSONB,
ADD COLUMN     "publishedAt" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "Landing_Config_Entries" ADD CONSTRAINT "Landing_Config_Entries_draftUpdatedById_fkey" FOREIGN KEY ("draftUpdatedById") REFERENCES "Admin_Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
