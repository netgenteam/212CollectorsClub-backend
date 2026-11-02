import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Max,
  MinLength,
} from 'class-validator';

export const LEGAL_AUDIT_DEFAULT_LIMIT = 50;
export const LEGAL_AUDIT_MAX_LIMIT = 200;
/** A78 / AD-90: same cap as the Markdown precheck. */
export const LEGAL_DRAFT_MAX_BYTES = 200 * 1024;
/** RIF (FR-111): J/G/V/E/P, 7-9 digits, check digit; hyphens optional. */
export const RIF_RE = /^[JGVEP]-?\d{7,9}-?\d$/i;
const INT32 = 2_147_483_647;

const trimToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

export class PutDraftDto {
  @ApiProperty({
    description: 'Markdown body, at most 200 KB (UTF-8).',
    maxLength: LEGAL_DRAFT_MAX_BYTES,
  })
  @IsString()
  @IsNotEmpty()
  bodyMd: string;

  @ApiProperty({
    minimum: 0,
    description:
      'Revision the editor loaded: 0 to create the draft, otherwise the `revision` of the draft being edited.',
  })
  @IsInt()
  @Min(0)
  @Max(INT32)
  baseRevision: number;
}

export class PublishDto {
  @ApiProperty({
    minimum: 1,
    description: 'Revision of the draft the admin saw (A69).',
  })
  @IsInt()
  @Min(1)
  @Max(INT32)
  expectedRevision: number;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  changeSummary: string;

  @ApiProperty()
  @IsBoolean()
  isSubstantial: boolean;

  @ApiProperty({
    example: '2026-12-01T00:00:00.000Z',
    description:
      'ISO 8601 with an explicit offset. Must be >= greatest(database now(), effectiveFrom of the last version) and at most 366 days ahead; never infinite.',
  })
  @IsString()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/,
    { message: 'effectiveFrom must be an ISO 8601 timestamp with offset' },
  )
  effectiveFrom: string;
}

export class RestoreDto {
  @ApiProperty({ minimum: 1, description: 'Published version to copy.' })
  @IsInt()
  @Min(1)
  @Max(INT32)
  version: number;
}

export class UpdateIdentityDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  legalName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'J-12345678-9',
    description: 'J/G/V/E/P + 7-9 digits + check digit; hyphens optional.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(20)
  @Matches(RIF_RE, { message: 'rif must look like J-12345678-9' })
  rif?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  fiscalAddress?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 254 })
  @IsOptional()
  @Transform(trimToNull)
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 40 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(40)
  phone?: string | null;
}

export class LegalPlaceholderDto {
  @ApiProperty({ example: '[[RAZON_SOCIAL]]' }) token: string;
  @ApiProperty({ example: 12 }) line: number;
}

export class AdminLegalListItemDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty() kind: string;
  @ApiProperty({ nullable: true, type: Number }) currentVersion: number | null;
  @ApiProperty({ nullable: true, type: String }) effectiveFrom: string | null;
  @ApiProperty({ nullable: true, type: Number }) latestVersion: number | null;
  @ApiProperty() hasDraft: boolean;
  @ApiProperty({ nullable: true, type: Number }) draftRevision: number | null;
  @ApiProperty({ nullable: true, type: String })
  draftUpdatedAt: string | null;
  @ApiProperty({ description: 'Unresolved [[PLACEHOLDERS]] of the draft.' })
  pendingPlaceholders: number;
}

export class LegalDraftResponseDto {
  @ApiProperty() slug: string;
  @ApiProperty() bodyMd: string;
  @ApiProperty() revision: number;
  @ApiProperty({ nullable: true, type: Number }) baseVersionNumber:
    number | null;
  @ApiProperty({ nullable: true, type: Number }) restoredFromVersion:
    number | null;
  @ApiProperty() updatedAt: string;
  @ApiProperty({ nullable: true, type: String }) updatedByEmail: string | null;
  @ApiProperty({ type: [LegalPlaceholderDto] })
  placeholders: LegalPlaceholderDto[];
}

export class PublishedVersionDto {
  @ApiProperty() slug: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty() publishedAt: string;
  @ApiProperty() changeSummary: string;
  @ApiProperty() isSubstantial: boolean;
  @ApiProperty({ nullable: true, type: Number }) restoredFromVersion:
    number | null;
}

export class HistoryItemDto {
  @ApiProperty() versionNumber: number;
  @ApiProperty({ nullable: true, type: String }) publishedByEmail:
    string | null;
  @ApiProperty() publishedAt: string;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty() changeSummary: string;
  @ApiProperty() isSubstantial: boolean;
  @ApiProperty({ nullable: true, type: Number }) restoredFromVersion:
    number | null;
  @ApiProperty({ description: 'Highest version already in force.' })
  isCurrent: boolean;
  @ApiProperty({ description: 'effectiveFrom is still in the future.' })
  isScheduled: boolean;
}

export class HistoryResponseDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: [HistoryItemDto] }) versions: HistoryItemDto[];
}

export class DiffHunkDto {
  @ApiProperty({ enum: ['added', 'removed', 'context'] })
  type: 'added' | 'removed' | 'context';
  @ApiProperty({ type: [String] }) lines: string[];
  @ApiProperty({ description: '1-based line in `from` where the run starts.' })
  oldStart: number;
  @ApiProperty({ description: '1-based line in `to` where the run starts.' })
  newStart: number;
}

export class DiffStatsDto {
  @ApiProperty() added: number;
  @ApiProperty() removed: number;
}

export class DiffResponseDto {
  @ApiProperty() from: number;
  @ApiProperty() to: number;
  @ApiProperty({ type: DiffStatsDto }) stats: DiffStatsDto;
  @ApiProperty({ type: [DiffHunkDto] }) hunks: DiffHunkDto[];
}

export class AuditItemDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) slug: string | null;
  @ApiProperty({
    enum: [
      'DRAFT_CREATED',
      'DRAFT_EDITED',
      'PUBLISHED',
      'DRAFT_DISCARDED',
      'RESTORED',
      'IDENTITY_UPDATED',
    ],
  })
  action: string;
  @ApiProperty({ nullable: true, type: String }) adminUserId: string | null;
  @ApiProperty({ nullable: true, type: String }) adminEmail: string | null;
  @ApiProperty({ nullable: true, type: Number }) versionNumber: number | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  meta: Record<string, unknown>;
  @ApiProperty() createdAt: string;
}

export class AuditResponseDto {
  @ApiProperty({ type: [AuditItemDto] }) items: AuditItemDto[];
}

export class IdentityResponseDto {
  @ApiProperty({ nullable: true, type: String }) legalName: string | null;
  @ApiProperty({ nullable: true, type: String }) rif: string | null;
  @ApiProperty({ nullable: true, type: String }) fiscalAddress: string | null;
  @ApiProperty({ nullable: true, type: String }) contactEmail: string | null;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
  @ApiProperty({
    description:
      'false when legalName or rif is missing: the public footer omits the line (FR-111).',
  })
  complete: boolean;
  @ApiProperty({ type: [String], description: 'Missing required fields.' })
  missing: string[];
}
