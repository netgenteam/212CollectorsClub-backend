import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * Story 10.1. Body of `PUT /api/v1/admin/landing-content/texts/{key}`.
 * `value` is the whole content of the field — always a plain string (a
 * "texts" entry is always `valueType = "text"`, never a nested object).
 *
 * Deliberately NOT `@IsNotEmpty()`: an empty string is a legal value for
 * e.g. `announcementBarText` (the frontend's own convention for "hide the
 * announcement strip"), so this DTO only bounds length, not presence.
 */
export class UpdateLandingTextDto {
  @ApiProperty({
    example: 'Bienvenido a 212 Collectors Club',
    description:
      'The new text value for this field. May be an empty string where the field is optional content (e.g. announcementBarText).',
    maxLength: 2000,
  })
  @IsString()
  @MaxLength(2000)
  value: string;
}
