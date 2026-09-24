import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * Story 10.2. Body of `PUT /api/v1/admin/landing-content/drop212/{key}`.
 * Shared by both fixed `drop212` keys ("targetDate", "displayText") — on
 * the wire `value` is always a plain string either way (an ISO-8601
 * date/time string for "targetDate", free text for "displayText").
 *
 * Deliberately only `@IsString()`/`@MaxLength()` here (the same generic
 * criterion Story 10.1's `UpdateLandingTextDto` uses) — the
 * *targetDate-specific* real-ISO-8601 check does NOT live on this DTO. It
 * runs imperatively inside `LandingContentService.upsertDrop212`, because
 * it must apply conditionally on the `:key` route param ("displayText"
 * must NOT be ISO-8601-checked), and a static DTO class/decorator has no
 * visibility into that param — see that method's doc comment.
 */
export class UpdateLandingDrop212Dto {
  @ApiProperty({
    example: '2026-12-25T00:00:00.000Z',
    description:
      'The new value for this drop212 field. Must be a real ISO-8601 date/time string when the key is "targetDate" (validated specifically in LandingContentService, not here); free text when the key is "displayText" (same criterion as the "texts" section from Story 10.1 — an empty string is a legal value there).',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  value: string;
}
