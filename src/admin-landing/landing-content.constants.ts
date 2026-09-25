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
 * Story 10.2 (`section` = "drop212") added its own sibling constant list
 * (`LANDING_DROP212_KEYS`, below) in this same file, reusing the same
 * `notEditableException()` rejection mechanism and adding its OWN route on
 * the existing `AdminLandingContentController` (no new controller class
 * needed).
 *
 * Story 10.3 (`section` = "pack_simulator") reuses the same table/
 * controller/service shape (one more `PUT` route, no new module) but
 * deliberately does NOT reuse the fixed-key-set pattern above — see the
 * `LANDING_SECTION_PACK_SIMULATOR` doc comment further down in this file
 * for why an open key set is the correct call there, backed by AD-9 and the
 * PRD's own FR-31 notes.
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

/**
 * Story 10.2 (FR-30, AD-9, AD-10): the "drop212" section — exactly the
 * sibling constant list `landing-content.constants.ts`'s own doc comment
 * (above) anticipated 10.1 would need. Same fixed-key enforcement pattern
 * as `LANDING_TEXT_KEYS`/`LANDING_BANNER_KEYS`, reusing the SAME
 * `notEditableException()` rejection helper in `LandingContentService`
 * (never duplicated) — only the key SET is new here, not the rejection
 * mechanism.
 *
 * - `targetDate`: the Drop 212 countdown's target date/time. Unlike every
 *   other `LandingConfigEntry` value so far (free-form text/JSON, only
 *   `@IsString()`-checked), this one gets a REAL, section-specific
 *   ISO-8601 validation (format AND real-calendar-date, e.g. rejects
 *   "2026-02-30") — see `LandingContentService.upsertDrop212` for why that
 *   check lives there (imperative, class-validator's `isISO8601()`
 *   function) rather than as a static DTO decorator: it only applies to
 *   THIS key, not to `displayText`, and both share one route/DTO.
 * - `displayText`: free-text countdown caption (e.g. "¡El próximo Drop 212
 *   está por llegar!") — same validation criterion as Story 10.1's
 *   "texts" section (`@IsString()` + length bound only, empty string
 *   legal).
 */
export const LANDING_SECTION_DROP212 = 'drop212';

export const LANDING_DROP212_KEYS = ['targetDate', 'displayText'] as const;
export type LandingDrop212Key = (typeof LANDING_DROP212_KEYS)[number];

/** The one `drop212` key that gets the extra ISO-8601 validation. */
export const LANDING_DROP212_TARGET_DATE_KEY: LandingDrop212Key = 'targetDate';

export function isLandingDrop212Key(key: string): key is LandingDrop212Key {
  return (LANDING_DROP212_KEYS as readonly string[]).includes(key);
}

/**
 * Story 10.3 (FR-31, NFR-2; AD-9). The "pack_simulator" section —
 * deliberately the ONE section in this whole module that does NOT reuse the
 * fixed-key-set pattern above (`LANDING_TEXT_KEYS`/`LANDING_BANNER_KEYS`/
 * `LANDING_DROP212_KEYS`). This is a documented design decision, not an
 * oversight — read this before touching `LandingContentService.
 * upsertPackSimulator`:
 *
 * - `docs/prd.md` FR-31's own Notes say the exact variable list "cannot be
 *   fully specified until the frontend's Simulador de Sobres is designed"
 *   (PRD Open Question OQ7) and that this story "defines the *capability*
 *   ... the *schema* is a phase-blocking dependency on frontend design".
 * - `docs/architecture.md` (AD-9) is even more explicit: "This is explicitly
 *   a capability, not a final field list ... the JSONB column already
 *   accommodates whatever shape the real variables need — no backend
 *   migration expected."
 * - This story's own Technical Note: "no simulator business logic hardcoded
 *   server-side; the backend's job is store-and-serve."
 *
 * A fixed, closed key set (10.1/10.2's pattern) would force every new
 * simulator variable the eventual frontend needs (weights, featured-set
 * flags, per-rarity odds, pity-timer thresholds, whatever it turns out to
 * be) through a backend code change + redeploy just to add one more literal
 * to an array — exactly the rigidity AD-9 says this JSONB design exists to
 * avoid. So `pack_simulator` accepts ANY syntactically valid `key`, gated
 * only by `isValidPackSimulatorKeyFormat` below (shape/abuse hygiene, never
 * a business-meaning allowlist) — the closest thing this section has to
 * `isLandingTextKey`/`isLandingBannerKey`/`isLandingDrop212Key`, but it
 * checks the key's FORM, not its membership in a fixed set. There is no
 * `LANDING_KEY_NOT_EDITABLE` rejection path here at all; see
 * `LandingContentService.upsertPackSimulator`'s own doc comment for the
 * value-shape (size/depth) limits that replace it as this section's abuse
 * guard.
 */
export const LANDING_SECTION_PACK_SIMULATOR = 'pack_simulator';

/**
 * Key format limits (shape hygiene, not a business allowlist): 1-100 chars,
 * must start with a letter or underscore, and may otherwise contain only
 * letters/digits/`_`/`-`/`.` — the same conservative "looks like a config
 * variable name" shape every OTHER key in this table already has by
 * construction (heroTitle, banner1, targetDate, ...), just enforced by
 * regex instead of set-membership since there is no fixed list to check
 * against. Blocks whitespace, path-traversal-looking values (`../..`),
 * empty strings, and pathological long keys — not a security boundary on
 * its own (the key is always used as a parameterized Prisma value, never
 * interpolated into a query/path), but keeps the table's `key` column
 * sane and keeps a malicious/careless caller from spamming rows with junk
 * identifiers.
 */
export const PACK_SIMULATOR_KEY_MAX_LENGTH = 100;
const PACK_SIMULATOR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isValidPackSimulatorKeyFormat(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= PACK_SIMULATOR_KEY_MAX_LENGTH &&
    PACK_SIMULATOR_KEY_PATTERN.test(key)
  );
}

/**
 * Value shape (abuse) limits — NOT business validation. Nothing here ever
 * inspects what the JSON *means* (no odds-sum-to-100% check, no rarity
 * enum, no numeric range check — that would be exactly the "simulator
 * business logic hardcoded server-side" this story's Technical Note
 * forbids). These two limits only bound the generic *shape* of arbitrary
 * admin-supplied JSON, the same abuse-hygiene concern every other admin
 * write endpoint in this codebase handles with a `@MaxLength()` on a
 * string DTO field — `pack_simulator`'s `value` has no fixed field to put
 * `@MaxLength()` on, so the bound is enforced imperatively in
 * `LandingContentService.upsertPackSimulator` instead (same imperative-check
 * pattern Story 10.2 already established for `targetDate`'s ISO-8601
 * check):
 *
 * - `PACK_SIMULATOR_MAX_VALUE_DEPTH = 6`: generous headroom for any
 *   realistic "flat or nested" config the AC describes (a flat map is
 *   depth 1; a per-set -> per-rarity odds table is depth 2; even a
 *   deliberately over-engineered structure is unlikely to exceed 3-4) while
 *   still rejecting a pathological deeply-nested payload before it can
 *   cause runtime trouble (e.g. deep-recursion cost) anywhere downstream
 *   that later reads this value.
 * - `PACK_SIMULATOR_MAX_VALUE_SIZE_BYTES = 10_000` (~10 KB of serialized
 *   JSON): comfortably fits any real odds/config table (dozens of
 *   rarities/sets with room to spare) while blocking this open-ended,
 *   admin-authenticated JSONB column from being (ab)used as a
 *   general-purpose blob store.
 */
export const PACK_SIMULATOR_MAX_VALUE_DEPTH = 6;
export const PACK_SIMULATOR_MAX_VALUE_SIZE_BYTES = 10_000;
