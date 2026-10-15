import { ProductLanguage } from '../generated/prisma/enums.js';

/**
 * Story 13.7 (AD-37): Spanish display names of `ProductLanguage`. Typed as a
 * full Record so adding an enum value without a name fails to compile; the
 * order of the keys is the fixed order of `facets.languages`.
 */
export const LANGUAGE_NAMES: Record<ProductLanguage, string> = {
  ES: 'Español',
  EN: 'Inglés',
  JP: 'Japonés',
  CN: 'Chino',
  OTHER: 'Otro',
};

export const LANGUAGE_ORDER: ProductLanguage[] = [
  ProductLanguage.ES,
  ProductLanguage.EN,
  ProductLanguage.JP,
  ProductLanguage.CN,
  ProductLanguage.OTHER,
];
