BEGIN;
-- Story 22.3 (AD-106, FR-148, FR-155): manual simulator sets and cards, plus the idempotent conversion of the
-- old "simulador prueba" set. Additive: no existing table is touched (the old config in "Landing_Config_Entries"
-- stays as it is; it is only READ by the data step below).
--
-- ROLLBACK (manual; nothing else depends on these objects until story 22.4):
--   DROP TABLE "Simulator_Cards", "Simulator_Sets";
--   DROP TYPE "SimulatorRarityTier";
-- The old config is never modified, so the rollback needs no data restore.

-- CreateEnum (same 8 names as PACK_TIERS in src/simulator/pack-tiers.ts; a unit test compares both)
CREATE TYPE "SimulatorRarityTier" AS ENUM ('COMMON', 'UNCOMMON', 'RARE', 'DOUBLE_RARE', 'ULTRA_RARE', 'ILLUSTRATION_RARE', 'SPECIAL_ILLUSTRATION_RARE', 'HYPER_RARE');

-- CreateTable
CREATE TABLE "Simulator_Sets" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "nameKey" VARCHAR(120) NOT NULL,
    "imageUrl" VARCHAR(300),
    "template" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Simulator_Sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Simulator_Cards" (
    "id" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "rarityTier" "SimulatorRarityTier" NOT NULL,
    "number" VARCHAR(30),
    "imageUrl" VARCHAR(300),
    "marketPriceUsd" DECIMAL(10,2),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Simulator_Cards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Simulator_Cards_marketPriceUsd_check" CHECK ("marketPriceUsd" IS NULL OR "marketPriceUsd" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "Simulator_Sets_nameKey_key" ON "Simulator_Sets"("nameKey");

-- CreateIndex
CREATE INDEX "Simulator_Sets_isActive_idx" ON "Simulator_Sets"("isActive");

-- CreateIndex
CREATE INDEX "Simulator_Cards_setId_rarityTier_idx" ON "Simulator_Cards"("setId", "rarityTier");

-- CreateIndex (several NULL numbers in one set are allowed: unique only when there is a number)
CREATE UNIQUE INDEX "Simulator_Cards_setId_number_key" ON "Simulator_Cards"("setId", "number");

-- AddForeignKey
ALTER TABLE "Simulator_Cards" ADD CONSTRAINT "Simulator_Cards_setId_fkey" FOREIGN KEY ("setId") REFERENCES "Simulator_Sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DATA STEP (idempotent; test/simulator-manual-schema.e2e-spec.ts splits the file at this marker and runs it twice).
-- Converts the "simulador prueba" set(s) of the old config (section 'pack_simulator', key 'config') into INACTIVE
-- manual sets with 0 cards. Name: displayName, else setName of the matching Tcg_Ingest_Cursors row. Template:
-- the set's own, else templates[gameSlug], else the default pokemon template. No-op when the config or the name
-- does not exist (e.g. the local database). Pre-deploy check for the exact name:
--   SELECT jsonb_pretty(value) FROM "Landing_Config_Entries" WHERE section='pack_simulator' AND key='config';
INSERT INTO "Simulator_Sets" ("id", "name", "nameKey", "imageUrl", "template", "isActive", "version", "createdAt", "updatedAt")
SELECT DISTINCT ON (c."nameKey")
       gen_random_uuid(), c."name", c."nameKey", c."imageUrl", c."template", false, 1, now(), now()
  FROM (
    SELECT left(btrim(r."resolvedName"), 120) AS "name",
           left(lower(regexp_replace(btrim(r."resolvedName"), '\s+', ' ', 'g')), 120) AS "nameKey",
           CASE WHEN jsonb_typeof(r."el"->'imageUrl') = 'string'
                 AND (r."el"->>'imageUrl') ~ '^/uploads/public/landing/[A-Za-z0-9_./-]+$'
                 AND (r."el"->>'imageUrl') !~ '\.\.'
                 AND length(r."el"->>'imageUrl') <= 300
                THEN r."el"->>'imageUrl' END AS "imageUrl",
           COALESCE(
             CASE WHEN jsonb_typeof(r."el"->'template') = 'object' THEN r."el"->'template' END,
             CASE WHEN jsonb_typeof(r."cfg"->'templates') = 'object'
                   AND jsonb_typeof(r."cfg"->'templates'->(r."el"->>'gameSlug')) = 'object'
                  THEN r."cfg"->'templates'->(r."el"->>'gameSlug') END,
             '{"slots":[{"kind":"fixed","tier":"COMMON","count":4},{"kind":"fixed","tier":"UNCOMMON","count":3},{"kind":"reverse","count":2},{"kind":"rare","odds":{"RARE":70,"DOUBLE_RARE":15,"ULTRA_RARE":6,"ILLUSTRATION_RARE":6,"SPECIAL_ILLUSTRATION_RARE":2,"HYPER_RARE":1}}]}'::jsonb
           ) AS "template",
           r."ord"
      FROM (
        SELECT e."value" AS "cfg", s."el", s."ord",
               COALESCE(
                 NULLIF(btrim(CASE WHEN jsonb_typeof(s."el"->'displayName') = 'string' THEN s."el"->>'displayName' END), ''),
                 (SELECT t."setName" FROM "Tcg_Ingest_Cursors" t
                   WHERE t."gameSlug" = s."el"->>'gameSlug' AND t."setId" = s."el"->>'setId'
                   LIMIT 1)
               ) AS "resolvedName"
          FROM "Landing_Config_Entries" e
          CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(e."value"->'sets') = 'array' THEN e."value"->'sets' ELSE '[]'::jsonb END
               ) WITH ORDINALITY AS s("el", "ord")
         WHERE e."section" = 'pack_simulator' AND e."key" = 'config'
           AND jsonb_typeof(s."el") = 'object'
      ) r
     WHERE r."resolvedName" IS NOT NULL
       AND lower(btrim(r."resolvedName")) = 'simulador prueba'
  ) c
 ORDER BY c."nameKey", c."ord"
ON CONFLICT ("nameKey") DO NOTHING;
COMMIT;
