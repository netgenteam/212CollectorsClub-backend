-- CreateTable
CREATE TABLE "Product_Categories" (
    "productId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,

    CONSTRAINT "Product_Categories_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateIndex
CREATE INDEX "Product_Categories_categoryId_idx" ON "Product_Categories"("categoryId");

-- AddForeignKey
ALTER TABLE "Product_Categories" ADD CONSTRAINT "Product_Categories_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product_Categories" ADD CONSTRAINT "Product_Categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Story 13.5 (FR-50, AD-33): idempotent seed of the taxonomy derived from the
-- Franchise / ProductType enums (slugs are prefixed so a pre-existing ROOT
-- category such as "pokemon" is never touched). Mirrors SEEDED_TAXONOMY in
-- src/admin-catalog/seeded-taxonomy.ts (a unit test guards the drift).
INSERT INTO "Categories" ("id", "name", "slug", "type", "dimension", "isActive", "sortOrder", "parentId", "updatedAt")
VALUES
  (gen_random_uuid(), 'Pokémon',             'franchise-pokemon',             'SUBCATEGORY', 'FRANCHISE',     true, 0, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'One Piece',           'franchise-one-piece',           'SUBCATEGORY', 'FRANCHISE',     true, 1, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Magic: The Gathering','franchise-magic-the-gathering', 'SUBCATEGORY', 'FRANCHISE',     true, 2, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Yu-Gi-Oh!',           'franchise-yu-gi-oh',            'SUBCATEGORY', 'FRANCHISE',     true, 3, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Dragon Ball Super',   'franchise-dragon-ball-super',   'SUBCATEGORY', 'FRANCHISE',     true, 4, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Topps',               'franchise-topps',               'SUBCATEGORY', 'FRANCHISE',     true, 5, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Naruto',              'franchise-naruto',              'SUBCATEGORY', 'FRANCHISE',     true, 6, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Booster Pack',        'format-booster-pack',           'SUBCATEGORY', 'SEALED_FORMAT', true, 0, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Booster Box',         'format-booster-box',            'SUBCATEGORY', 'SEALED_FORMAT', true, 1, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Starter Deck',        'format-starter-deck',           'SUBCATEGORY', 'SEALED_FORMAT', true, 2, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Collector Tin',       'format-collector-tin',          'SUBCATEGORY', 'SEALED_FORMAT', true, 3, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accessory',           'format-accessory',              'SUBCATEGORY', 'SEALED_FORMAT', true, 4, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- Backfill: franchise tag for every product (OTHER has no mapping, so no row).
INSERT INTO "Product_Categories" ("productId", "categoryId")
SELECT p."id", c."id"
FROM "Products" p
JOIN (VALUES
  ('POKEMON',             'franchise-pokemon'),
  ('ONE_PIECE',           'franchise-one-piece'),
  ('MAGIC_THE_GATHERING', 'franchise-magic-the-gathering'),
  ('YU_GI_OH',            'franchise-yu-gi-oh'),
  ('DRAGON_BALL_SUPER',   'franchise-dragon-ball-super'),
  ('TOPPS',               'franchise-topps'),
  ('NARUTO',              'franchise-naruto')
) AS m("enumValue", "slug") ON m."enumValue" = p."franchise"::text
JOIN "Categories" c ON c."slug" = m."slug"
ON CONFLICT DO NOTHING;

-- Backfill: format tag for every non-SINGLE_CARD product.
INSERT INTO "Product_Categories" ("productId", "categoryId")
SELECT p."id", c."id"
FROM "Products" p
JOIN (VALUES
  ('BOOSTER_PACK',  'format-booster-pack'),
  ('BOOSTER_BOX',   'format-booster-box'),
  ('STARTER_DECK',  'format-starter-deck'),
  ('COLLECTOR_TIN', 'format-collector-tin'),
  ('ACCESSORY',     'format-accessory')
) AS m("enumValue", "slug") ON m."enumValue" = p."productType"::text
JOIN "Categories" c ON c."slug" = m."slug"
ON CONFLICT DO NOTHING;
