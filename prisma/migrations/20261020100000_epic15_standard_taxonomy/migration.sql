-- Story 15.1 (FR-60..63, AD-51): standard taxonomy data migration. Data only,
-- idempotent, no hardcoded UUIDs. Order matters (R3): roots -> parentId ->
-- cleanup -> tags. Mirrors STANDARD_ROOT_SLUGS in
-- src/admin-catalog/seeded-taxonomy.ts (a unit test guards the drift).

-- (1) Three standard ROOT categories, created by slug.
INSERT INTO "Categories" ("id", "name", "slug", "type", "dimension", "isActive", "sortOrder", "parentId", "updatedAt")
VALUES
  (gen_random_uuid(), 'Franquicia TCG',   'franquicia-tcg',   'ROOT', NULL, true, 0, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Formato Sellado',  'formato-sellado',  'ROOT', NULL, true, 1, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Idioma / Edición', 'idioma-edicion',   'ROOT', NULL, true, 2, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- (2) Orphan SUBCATEGORY rows get the root of their dimension as parent
-- (mapped by dimension, not by slug list; rows with a parent are untouched).
UPDATE "Categories" c
SET "parentId" = r."id", "updatedAt" = CURRENT_TIMESTAMP
FROM "Categories" r
JOIN (VALUES
  ('FRANCHISE',        'franquicia-tcg'),
  ('SEALED_FORMAT',    'formato-sellado'),
  ('EDITION_LANGUAGE', 'idioma-edicion')
) AS m("dimension", "rootSlug") ON m."rootSlug" = r."slug"
WHERE c."type" = 'SUBCATEGORY'
  AND c."parentId" IS NULL
  AND c."dimension"::text = m."dimension"
  AND r."type" = 'ROOT';

-- (3) Cleanup of obsolete childless ROOT categories: delete when unused,
-- deactivate when any product references them. Protected slugs are never touched.
DO $$
DECLARE
  cand RECORD;
BEGIN
  FOR cand IN
    SELECT c."id", c."slug"
    FROM "Categories" c
    WHERE c."type" = 'ROOT'
      AND c."slug" NOT IN ('cartas-sueltas', 'sobres-y-cajas', 'franquicia-tcg', 'formato-sellado', 'idioma-edicion')
      AND NOT EXISTS (SELECT 1 FROM "Categories" ch WHERE ch."parentId" = c."id")
  LOOP
    IF NOT EXISTS (SELECT 1 FROM "Products" p WHERE p."categoryId" = cand."id")
       AND NOT EXISTS (SELECT 1 FROM "Product_Categories" pc WHERE pc."categoryId" = cand."id") THEN
      DELETE FROM "Categories" WHERE "id" = cand."id";
      RAISE NOTICE 'epic15_standard_taxonomy: root "%" has no usage -> deleted', cand."slug";
    ELSE
      UPDATE "Categories" SET "isActive" = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = cand."id" AND "isActive" = true;
      RAISE NOTICE 'epic15_standard_taxonomy: root "%" is in use -> deactivated (isActive=false)', cand."slug";
    END IF;
  END LOOP;
END $$;

-- (4a) No SINGLE_CARD keeps a SEALED_FORMAT tag.
DELETE FROM "Product_Categories" pc
USING "Products" p, "Categories" c
WHERE pc."productId" = p."id"
  AND pc."categoryId" = c."id"
  AND p."productType" = 'SINGLE_CARD'
  AND c."dimension" = 'SEALED_FORMAT';

-- (4b) Franchise tag for every product of the 5 supported games (idempotent).
INSERT INTO "Product_Categories" ("productId", "categoryId")
SELECT p."id", c."id"
FROM "Products" p
JOIN (VALUES
  ('POKEMON',             'franchise-pokemon'),
  ('ONE_PIECE',           'franchise-one-piece'),
  ('MAGIC_THE_GATHERING', 'franchise-magic-the-gathering'),
  ('YU_GI_OH',            'franchise-yu-gi-oh'),
  ('DRAGON_BALL_SUPER',   'franchise-dragon-ball-super')
) AS m("enumValue", "slug") ON m."enumValue" = p."franchise"::text
JOIN "Categories" c ON c."slug" = m."slug"
ON CONFLICT DO NOTHING;
