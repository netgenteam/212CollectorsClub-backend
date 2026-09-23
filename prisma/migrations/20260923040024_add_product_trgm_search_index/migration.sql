-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "Products_name_idx" ON "Products" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Products_description_idx" ON "Products" USING GIN ("description" gin_trgm_ops);
