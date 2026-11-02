import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const KINDS = [
  'TERMS',
  'PRIVACY',
  'COOKIES',
  'SHIPPING',
  'RETURNS',
  'LEGAL_NOTICE',
] as const;
export type LegalStatus = 'PUBLISHED' | 'IN_PREPARATION';

export class LegalTocEntryDto {
  @ApiProperty({ enum: [2, 3] }) depth: 2 | 3;
  @ApiProperty({ example: 'Datos que recopilamos' }) text: string;
  @ApiProperty({ example: 'datos-que-recopilamos' }) id: string;
}

export class LegalListItemDto {
  @ApiProperty({ example: 'terminos' }) slug: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: KINDS }) kind: string;
  @ApiProperty() requiresAcceptance: boolean;
  @ApiProperty({ enum: ['PUBLISHED', 'IN_PREPARATION'] }) status: LegalStatus;
  @ApiPropertyOptional({ description: 'Only when PUBLISHED.' })
  currentVersion?: number;
  @ApiPropertyOptional({ description: 'ISO 8601; only when PUBLISHED.' })
  effectiveFrom?: string;
}

export class LegalCurrentVersionDto {
  @ApiProperty() slug: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Highest effective versionNumber flagged isSubstantial (null if none).',
  })
  lastSubstantialVersion: number | null;
}

export class LegalCurrentVersionsResponseDto {
  @ApiProperty({ type: [LegalCurrentVersionDto] })
  documents: LegalCurrentVersionDto[];
}

export class LegalIdentityDto {
  @ApiProperty({ nullable: true, type: String }) legalName: string | null;
  @ApiProperty({ nullable: true, type: String }) rif: string | null;
  @ApiProperty({ nullable: true, type: String }) fiscalAddress: string | null;
  @ApiProperty({ nullable: true, type: String }) contactEmail: string | null;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
}

export class LegalVersionBodyDto {
  @ApiProperty() versionNumber: number;
  @ApiProperty({ description: 'Validated Markdown (no HTML, no images).' })
  bodyMd: string;
  @ApiProperty({ type: [LegalTocEntryDto] }) toc: LegalTocEntryDto[];
  @ApiProperty() changeSummary: string;
  @ApiProperty() isSubstantial: boolean;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty() publishedAt: string;
}

export class LegalUpcomingDto {
  @ApiProperty() versionNumber: number;
  @ApiProperty() effectiveFrom: string;
}

export class LegalDocumentResponseDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: ['PUBLISHED', 'IN_PREPARATION'] }) status: LegalStatus;
  @ApiPropertyOptional({ type: LegalVersionBodyDto })
  version?: LegalVersionBodyDto;
  @ApiPropertyOptional({ type: LegalUpcomingDto })
  upcoming?: LegalUpcomingDto;
}

export class LegalVersionSummaryDto {
  @ApiProperty() versionNumber: number;
  @ApiProperty() changeSummary: string;
  @ApiProperty() isSubstantial: boolean;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty() publishedAt: string;
  @ApiProperty({ description: 'true for the one in force now.' })
  isCurrent: boolean;
}

export class LegalVersionsResponseDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty({
    type: [LegalVersionSummaryDto],
    description: 'Effective versions, newest first. Never drafts.',
  })
  versions: LegalVersionSummaryDto[];
}

export class LegalVersionDetailDto extends LegalVersionBodyDto {
  @ApiProperty() isCurrent: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'effectiveFrom of the version that replaced it (null if current).',
  })
  supersededAt: string | null;
}

export class LegalVersionResponseDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: LegalVersionDetailDto }) version: LegalVersionDetailDto;
}
