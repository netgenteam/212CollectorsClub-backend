import type { Franchise, ProductType } from '../generated/prisma/enums.js';

/**
 * Story 13.5 (FR-50, AD-33): enum value -> slug of the seeded SUBCATEGORY that
 * mirrors it. `Franchise.OTHER` and `ProductType.SINGLE_CARD` have no tag by
 * design. The migration `add_product_categories` seeds exactly these slugs
 * (a unit test guards the drift).
 */
export const SEEDED_TAXONOMY = {
  franchise: {
    POKEMON: 'franchise-pokemon',
    ONE_PIECE: 'franchise-one-piece',
    MAGIC_THE_GATHERING: 'franchise-magic-the-gathering',
    YU_GI_OH: 'franchise-yu-gi-oh',
    DRAGON_BALL_SUPER: 'franchise-dragon-ball-super',
    TOPPS: 'franchise-topps',
    NARUTO: 'franchise-naruto',
  } satisfies Partial<Record<Franchise, string>> as Partial<
    Record<Franchise, string>
  >,
  productType: {
    BOOSTER_PACK: 'format-booster-pack',
    BOOSTER_BOX: 'format-booster-box',
    STARTER_DECK: 'format-starter-deck',
    COLLECTOR_TIN: 'format-collector-tin',
    ACCESSORY: 'format-accessory',
  } satisfies Partial<Record<ProductType, string>> as Partial<
    Record<ProductType, string>
  >,
};

/** Every seeded slug (franchise + format). */
export const SEEDED_SLUGS: readonly string[] = [
  ...Object.values(SEEDED_TAXONOMY.franchise),
  ...Object.values(SEEDED_TAXONOMY.productType),
];

/** Slugs of the tags derived from a product's enums (AD-38). */
export function derivedTagSlugs(
  franchise: Franchise,
  productType: ProductType,
): string[] {
  const slugs: string[] = [];
  const f = SEEDED_TAXONOMY.franchise[franchise];
  if (f) slugs.push(f);
  const t = SEEDED_TAXONOMY.productType[productType];
  if (t) slugs.push(t);
  return slugs;
}
