import { ApiProperty } from '@nestjs/swagger';

/** Story 16.1 (AD-61). Row of `GET /admin/landing-content/blocks`. */
export class LandingBlockSummaryDto {
  @ApiProperty({ example: 'hero' })
  block: string;

  @ApiProperty()
  hasDraft: boolean;

  @ApiProperty()
  hasPublished: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  draftUpdatedAt: Date | null;
}

export class LandingBlockListResponseDto {
  @ApiProperty({ type: [LandingBlockSummaryDto] })
  data: LandingBlockSummaryDto[];
}

/** Body of GET/PUT `blocks/:block`. */
export class LandingBlockDetailDto {
  @ApiProperty({ example: 'hero' })
  block: string;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Published value, null if never published.',
  })
  published: Record<string, unknown> | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Pending draft, null if none.',
  })
  draft: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  draftUpdatedAt: Date | null;
}

export class LandingPublishAllResponseDto {
  @ApiProperty({ type: [String], example: ['hero', 'ticker'] })
  published: string[];
}
