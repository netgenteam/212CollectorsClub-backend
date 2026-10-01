import { ProductType } from '../generated/prisma/enums.js';

/**
 * Story 11.2 (AD-19): catalog macro-categories. A TS const (not a DB enum)
 * mapping each macro-category to the ProductTypes it contains.
 */
export const MacroCategory = {
  SEALED: 'SEALED',
  SINGLES: 'SINGLES',
} as const;

export type MacroCategory = (typeof MacroCategory)[keyof typeof MacroCategory];

export const MACRO_CATEGORY_TYPES: Record<MacroCategory, ProductType[]> = {
  SEALED: [
    ProductType.BOOSTER_PACK,
    ProductType.BOOSTER_BOX,
    ProductType.STARTER_DECK,
    ProductType.COLLECTOR_TIN,
    ProductType.ACCESSORY,
  ],
  SINGLES: [ProductType.SINGLE_CARD],
};
