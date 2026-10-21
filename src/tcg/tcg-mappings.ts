import type {
  Franchise,
  ProductLanguage,
  Rarity,
} from '../generated/prisma/enums.js';

/**
 * Story 15.3 (AD-54, A38): mappings shared by the ingestion and the product
 * creation from a master card. `scripts/import-tcgapi.mjs` keeps its own copy
 * (legacy tool); `mapRarity` must keep returning the same values as the script.
 */
export const FRANCHISE_BY_GAME: Record<string, Franchise> = {
  pokemon: 'POKEMON',
  'pokemon-japan': 'POKEMON',
  magic: 'MAGIC_THE_GATHERING',
  yugioh: 'YU_GI_OH',
  'one-piece-card-game': 'ONE_PIECE',
  'dragon-ball-super-ccg': 'DRAGON_BALL_SUPER',
  'dragon-ball-super-fusion-world': 'DRAGON_BALL_SUPER',
  naruto: 'NARUTO',
};

/** Games whose cards are not English; every other game defaults to EN. */
export const EDITION_LANGUAGE_BY_GAME: Record<string, ProductLanguage> = {
  'pokemon-japan': 'JP',
};

export function franchiseForGame(
  gameSlug: string | null | undefined,
): Franchise {
  return (gameSlug && FRANCHISE_BY_GAME[gameSlug]) || 'OTHER';
}

export function editionLanguageForGame(
  gameSlug: string | null | undefined,
): ProductLanguage {
  return (gameSlug && EDITION_LANGUAGE_BY_GAME[gameSlug]) || 'EN';
}

export function mapRarity(raw: string | null | undefined = ''): Rarity {
  const r = (raw ?? '').toLowerCase();
  if (r.includes('promo')) return 'PROMO';
  if (/secret|hyper|special illustration|gold|manga|alternate art/.test(r)) {
    return 'SECRET_RARE';
  }
  if (
    /ultra|illustration|double rare|\bex\b|\bgx\b|\bv(max|star)?\b|mythic|super rare|leader/.test(
      r,
    )
  ) {
    return 'ULTRA_RARE';
  }
  if (r.includes('uncommon')) return 'UNCOMMON';
  if (r.includes('rare')) return 'RARE';
  return 'COMMON';
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200)
    .replace(/-+$/, '');
}

/** Lowercase, NFKD, no accents/symbols, single spaces (MasterCard.searchText). */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
