import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VERIFY_DEFAULT_LIMIT } from './audit-chain-verifier.js';

export const VERIFY_MAX_LIMIT = 200_000;

export class VerifyAuditDto {
  @ApiPropertyOptional({
    enum: ['incremental', 'full'],
    default: 'incremental',
    description:
      '`incremental` starts at the last OK verification (re-checking its last row); `full` starts at seq 1.',
  })
  @IsOptional()
  @IsIn(['incremental', 'full'])
  mode?: 'incremental' | 'full';

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Resume point: the `nextFromSeq` of a previous partial answer. Rows before it are trusted.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  fromSeq?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: VERIFY_MAX_LIMIT,
    default: VERIFY_DEFAULT_LIMIT,
    description: 'Maximum rows examined by this call.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VERIFY_MAX_LIMIT)
  limit?: number;
}

export class BrokenAtDto {
  @ApiProperty() seq: number;
  @ApiProperty({
    enum: [
      'HASH_MISMATCH',
      'PREV_HASH_MISMATCH',
      'SEQ_GAP',
      'GENESIS_MISMATCH',
      'ANCHOR_CHANGED',
      'HASH_VERSION',
    ],
  })
  reason: string;
  @ApiProperty({
    description:
      'The hash the chain requires (or the missing seq for SEQ_GAP).',
  })
  expected: string;
  @ApiProperty({ nullable: true, type: String })
  found: string | null;
}

export class VerifyResponseDto {
  @ApiProperty() ok: boolean;
  @ApiProperty({ enum: ['incremental', 'full'] }) mode: string;
  @ApiProperty() checkedFrom: number;
  @ApiProperty() checkedTo: number;
  @ApiProperty() rows: number;
  @ApiPropertyOptional({ type: BrokenAtDto }) brokenAt?: BrokenAtDto;
  @ApiPropertyOptional({
    description: 'Send it as `fromSeq` to continue when `done` is false.',
  })
  nextFromSeq?: number;
  @ApiProperty({ description: 'True when the chain has been read to its end.' })
  done: boolean;
  @ApiProperty({
    description:
      'True when this run did NOT cover the chain from the genesis to its end (fromSeq > 1, stopped by `limit`, or an incremental run that trusts the rows before its anchor). A partial OK says nothing about the rest of the chain.',
  })
  partial: boolean;
  @ApiProperty({ format: 'uuid' }) verificationId: string;
  @ApiProperty() headSeq: number;
  @ApiProperty() headHash: string;
}

export class AuditEventDto {
  @ApiProperty() seq: number;
  @ApiProperty({ format: 'date-time' }) occurredAt: string;
  @ApiProperty({ enum: ['ADMIN', 'SYSTEM', 'CUSTOMER', 'ANON'] })
  actorType: string;
  @ApiProperty({ nullable: true, type: String }) actorId: string | null;
  @ApiProperty() action: string;
  @ApiProperty() entityType: string;
  @ApiProperty() entityId: string;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  before: unknown;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  after: unknown;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId: string | null;
  @ApiProperty({ nullable: true, type: String }) ip: string | null;
  @ApiProperty() hashVersion: number;
  @ApiProperty() prevHash: string;
  @ApiProperty() hash: string;
}

export class AuditEventDetailDto extends AuditEventDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Relative admin screen of the entity, when known.',
  })
  entityLink: string | null;
}

export class AuditEventsPageDto {
  @ApiProperty({ type: [AuditEventDto] }) items: AuditEventDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Pass it as `cursor` for the next page; null on the last one.',
  })
  nextCursor: string | null;
}

export class AuditHeadDto {
  @ApiProperty({ description: '0 when the chain is empty.' }) seq: number;
  @ApiProperty({
    description: 'Write it down OUTSIDE the database (external anchor).',
  })
  hash: string;
  @ApiProperty({
    description:
      'Rows in the chain. Equals `seq`: the database guarantees a gapless chain (a gap is reported by the verification, not counted here).',
  })
  count: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) at:
    string | null;
  @ApiProperty({
    description:
      'True when AUDIT_ANCHOR_EMAIL is set (the weekly external anchor of the head). False: nobody outside the database keeps the head hash.',
  })
  anchorEmailConfigured: boolean;
}

export class AuditVerificationsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  items: Record<string, unknown>[];
  @ApiProperty({
    description: 'True while the LATEST verification found the chain broken.',
  })
  chainBroken: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastBrokenAt: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Start of the latest OK verification that covered the chain from the genesis to its end in one run (partial = false). Null: none yet.',
  })
  lastCompleteVerificationAt: string | null;
  @ApiProperty({
    description: 'True when AUDIT_ANCHOR_EMAIL is set (see /head).',
  })
  anchorEmailConfigured: boolean;
}
