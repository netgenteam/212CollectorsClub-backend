import { ApiProperty } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';

/**
 * Story 10.3. Body of `PUT /api/v1/admin/landing-content/pack_simulator/{key}`.
 *
 * Unlike `UpdateLandingTextDto`/`UpdateLandingDrop212Dto` (always a plain
 * string) or `UpdateLandingBannerDto` (always the same fixed 3-field
 * object), `value` here is deliberately typed `unknown` — this section's
 * whole point (AD-9, FR-31, PRD OQ7) is accepting a JSON value of ANY shape
 * the eventual frontend simulator needs, flat or nested, with no backend
 * schema change. `@IsDefined()` is the one decorator present — it does two
 * things:
 *  1. Keeps `value` from being stripped by the global `ValidationPipe`'s
 *     `whitelist: true` (class-validator only keeps properties that carry
 *     at least one validation decorator; an undecorated `value: unknown`
 *     would silently vanish from the request before it ever reached the
 *     controller).
 *  2. Rejects the "value absent" case (`undefined` — i.e. the property was
 *     never sent — AND `null`, which class-validator's `IsDefined` treats
 *     the same way) with Nest's standard 400 shape, before any handler code
 *     runs.
 *
 * Deliberately NOT `@IsObject()`/`@IsNotEmptyObject()` — a "flat" value per
 * the AC can legitimately be a bare string/number/boolean (e.g. a single
 * tunable like `packPriceUsd: 4.99`), not only an object, so this DTO must
 * not narrow the type beyond "was actually provided".
 *
 * The real shape/abuse-hygiene limits (max nesting depth, max serialized
 * size) are NOT expressible as a static class-validator decorator on an
 * `unknown`-typed field — they run imperatively inside
 * `LandingContentService.upsertPackSimulator`, the same imperative-check
 * pattern Story 10.2 established for `targetDate`'s ISO-8601 validation.
 */
export class UpdatePackSimulatorDto {
  @ApiProperty({
    example: { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 },
    description:
      'The new value for this pack_simulator variable — any JSON value (string, number, boolean, array, flat object, or nested object, e.g. a per-rarity odds table). Stored as-is in JSONB; the backend never inspects or validates its business meaning (no odds-math, no weighting rules — store-and-serve only). Bounded only by a generic max nesting depth and max serialized size (abuse hygiene, not business validation) — see landing-content.constants.ts.',
  })
  @IsDefined()
  value: unknown;
}
