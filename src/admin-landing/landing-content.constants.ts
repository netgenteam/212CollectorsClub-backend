/**
 * Story 10.1 (AD-9, FR-29): the fixed, pre-defined set of editable
 * `LandingConfigEntry` keys for the "texts" and "banners" sections — this
 * is the enforcement point for the story's "the admin cannot add arbitrary
 * new sections/fields through this capability" AC. Neither the PRD nor
 * `docs/stories/10.1-...md` enumerates an exact field list for a general
 * e-commerce landing page, so this list is a Dev-authored product decision
 * for a dark-theme premium TCG storefront, NOT a client-confirmed
 * requirement — flagged for Angel/Nabil review (see the Story 10.1 Dev
 * report). Chosen with a deliberately small, high-value footprint (a hero
 * block + 3 promotional banners) rather than a large arbitrary field list,
 * since every key here is a real migration-free commitment the frontend
 * will build against.
 *
 * Both `LANDING_TEXT_KEYS`/`LANDING_BANNER_KEYS` are read by
 * `LandingContentService` to reject (400 `LANDING_KEY_NOT_EDITABLE`) any
 * `PUT` whose `:key` isn't in the matching list — no row is ever created
 * for a key outside these two lists, by construction (the service never
 * calls `upsert` unless the key passed this check first).
 *
 * Stories 10.2 (`section` = "drop212") and 10.3 (`section` =
 * "pack_simulator") are expected to add their OWN sibling constant lists in
 * this same file (or a story-specific one) and their OWN admin
 * controllers/routes — this file only ever governs "texts"/"banners".
 */

export const LANDING_SECTION_TEXTS = 'texts';
export const LANDING_SECTION_BANNERS = 'banners';

/**
 * "texts" — plain single-string homepage copy, each rendered as `valueType
 * = "text"` (a raw string, JSON-encoded).
 *
 * - `heroTitle` / `heroSubtitle`: the homepage's primary hero headline and
 *   supporting subtitle.
 * - `heroCtaText` / `heroCtaUrl`: the hero's call-to-action button label and
 *   the path/URL it links to — a CTA label without a destination isn't
 *   independently useful, so both are included as one product decision
 *   even though the story text only names "CTA text".
 * - `announcementBarText`: an optional top-of-page announcement strip
 *   (shipping/promo note), a very common premium-storefront pattern — kept
 *   as a single free-text field, never required to be non-empty at seed
 *   time by anything downstream (an empty string is a legal value, meaning
 *   "hide the strip", left to the frontend to interpret).
 */
export const LANDING_TEXT_KEYS = [
  'heroTitle',
  'heroSubtitle',
  'heroCtaText',
  'heroCtaUrl',
  'announcementBarText',
] as const;
export type LandingTextKey = (typeof LANDING_TEXT_KEYS)[number];

/**
 * "banners" — 3 fixed promotional banner slots, each rendered as
 * `valueType = "json"`: `{ imageUrl, title, linkUrl }`. One
 * `LandingConfigEntry` row per banner (not one row per field) — a banner's
 * 3 fields are edited together as a single unit via one `PUT` call, which
 * is both the natural admin-UI form shape (one form per banner) and halves
 * the row count vs. one row per field.
 */
export const LANDING_BANNER_KEYS = ['banner1', 'banner2', 'banner3'] as const;
export type LandingBannerKey = (typeof LANDING_BANNER_KEYS)[number];

export function isLandingTextKey(key: string): key is LandingTextKey {
  return (LANDING_TEXT_KEYS as readonly string[]).includes(key);
}

export function isLandingBannerKey(key: string): key is LandingBannerKey {
  return (LANDING_BANNER_KEYS as readonly string[]).includes(key);
}
