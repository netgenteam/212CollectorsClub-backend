import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 10.1. Response shape of both admin `PUT` endpoints — the
 * `LandingConfigEntry` row that was just created/updated, exactly as it now
 * stands in Postgres (the same row the next public `GET
 * /api/v1/landing-content` will return, grouped under its `section`).
 */
export class LandingConfigEntryResponseDto {
  @ApiProperty({
    example: 'texts',
    description: 'Section this entry belongs to.',
  })
  section: string;

  @ApiProperty({
    example: 'heroTitle',
    description: 'Field key within the section.',
  })
  key: string;

  @ApiProperty({
    example: 'text',
    description: 'Admin-UI rendering hint ("text" | "json").',
  })
  valueType: string;

  @ApiProperty({
    description:
      'The stored value — a plain string for "texts" entries, or a { imageUrl, title, linkUrl } object for "banners" entries.',
  })
  value: unknown;

  @ApiProperty({ example: '2026-09-24T23:00:00.000Z' })
  updatedAt: Date;

  @ApiProperty({
    example: '3f9e1c2a-...-c1a2',
    description: 'Id of the AdminUser who made this edit.',
    nullable: true,
  })
  updatedById: string | null;
}
