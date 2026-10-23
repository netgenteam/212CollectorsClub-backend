import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Story 16.1 (AD-60). Building blocks shared by the seven `home/*` landing
 * block DTOs. Every block DTO is validated with `plainToInstance` +
 * `validate({ whitelist: true, forbidNonWhitelisted: true })` (see
 * `landing-blocks.validation.ts`), so an unknown property anywhere in the
 * tree is a 400, never silently stripped.
 */

export const SEGMENT_STYLES = [
  'solid',
  'outline',
  'gradient',
  'accent',
  'underline',
] as const;
export type SegmentStyle = (typeof SEGMENT_STYLES)[number];

/**
 * `Link.href`: a root-relative path (`/catalogo`, but never protocol-relative
 * `//host` or `/\host`, which browsers treat as an external host), an
 * in-page anchor (`#coleccion`) or an absolute `https://` URL. Never
 * `javascript:`, `data:` or plain `http:`.
 */
export const LINK_HREF_PATTERN =
  /^(\/(?![/\\])[^\s\\]*|#[a-z0-9-]+|https:\/\/[^\s]+)$/;

/** One styled run of text inside a title line (a `TitleLine` is `Segment[]`). */
export class SegmentDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: 'OBSESIVO' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  text: string;

  @ApiProperty({ enum: SEGMENT_STYLES, example: 'solid' })
  @IsIn(SEGMENT_STYLES)
  style: SegmentStyle;
}

export class LinkDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: 'Ver catálogo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label: string;

  @ApiProperty({
    maxLength: 500,
    example: '/catalogo',
    description:
      'Root-relative path ("/x", never "//host"), in-page anchor ("#x") or absolute "https://" URL.',
  })
  @IsString()
  @MaxLength(500)
  @Matches(LINK_HREF_PATTERN, {
    message:
      'href must be a root-relative path (not "//host"), an "#anchor" or an absolute https:// URL',
  })
  href: string;
}

export const TITLE_LINES_MAX_LINES = 4;
export const TITLE_LINES_MAX_SEGMENTS = 4;
