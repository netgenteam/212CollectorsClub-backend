import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { FxRateSource, FxSettingAction } from '../../generated/prisma/enums.js';

export const FX_HISTORY_DEFAULT_LIMIT = 50;
export const FX_HISTORY_MAX_LIMIT = 200;
export const FX_AUDIT_DEFAULT_LIMIT = 20;
export const FX_AUDIT_MAX_LIMIT = 100;

/** PUT /admin/fx/settings body (strictBody). */
export class UpdateFxSettingsDto {
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  @IsEnum(FxRateSource)
  source: FxRateSource;

  @ApiPropertyOptional({
    description:
      'VES per USD. REQUIRED (> 0) when source=MANUAL, else 400 FX_MANUAL_RATE_REQUIRED. Max 4 decimals.',
    example: 912.5,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Max(99999999999999)
  manualVesPerUsd?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 720, example: 48 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  maxAgeHours?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, example: 15 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(50)
  maxVariationPct?: number;
}

export class FxSettingsResponseDto {
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  source: FxRateSource;
  @ApiProperty({ type: String, nullable: true, example: '912.5000' })
  manualVesPerUsd: string | null;
  @ApiProperty({ example: 48 })
  maxAgeHours: number;
  @ApiProperty({ example: 15 })
  maxVariationPct: number;
  @ApiProperty({ example: '889.2600', description: 'Current rate (4 dp).' })
  vesPerUsd: string;
}

export class UpdateFxSettingsResponseDto extends FxSettingsResponseDto {
  @ApiProperty({
    description:
      'true when the immediate refresh after the save failed/was rejected/was busy: the previous rate is kept.',
  })
  stale: boolean;
  @ApiProperty({
    example: 'UPDATED',
    description:
      'Outcome of the immediate refresh: UPDATED | NOOP | MANUAL | REJECTED | FAILED | IN_PROGRESS | SKIPPED.',
  })
  refresh: string;
  @ApiProperty({
    description:
      'false only when a switch to a live source could not be applied (provider down/rejected AND no snapshot of that source): nothing was written and the previous source and rate are kept.',
  })
  sourceChanged: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'PROVIDER_ERROR',
    description:
      'Why the new source got no fresh reading: PROVIDER_ERROR, a rejection reason (VARIATION_EXCEEDED, DATE_REGRESSION, ...) or NO_RATE_AVAILABLE. null on success. When a snapshot of the new source exists the switch is applied with that snapshot rate/dates (stale:true).',
  })
  reason: string | null;
}

export class FxSourceLiveDto {
  @ApiProperty({ example: '889.2600' })
  rate: string;
  @ApiProperty({ format: 'date-time' })
  providerUpdatedAt: string;
  @ApiProperty({ format: 'date-time' })
  fetchedAt: string;
}

export class FxLiveSourcesDto {
  @ApiProperty({ type: FxSourceLiveDto, nullable: true })
  BCV_USD: FxSourceLiveDto | null;
  @ApiProperty({ type: FxSourceLiveDto, nullable: true })
  BCV_EUR: FxSourceLiveDto | null;
  @ApiProperty({ type: FxSourceLiveDto, nullable: true })
  PARALELO_USD: FxSourceLiveDto | null;
}

export class FxStatusResponseDto {
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  source: FxRateSource;
  @ApiProperty({ example: '889.2600' })
  rate: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  providerUpdatedAt: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the current rate was last confirmed (rateFetchedAt).',
  })
  fetchedAt: string | null;
  @ApiProperty({
    description: 'now - fetchedAt > maxAgeHours (never for MANUAL).',
  })
  stale: boolean;
  @ApiProperty({ description: '> maxAgeHours x 3 (never for MANUAL).' })
  hardStale: boolean;
  @ApiProperty({ type: String, nullable: true })
  lastError: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      '{source, rate, rawRate, providerUpdatedAt, reason, at} of the last rejected reading.',
  })
  rejectedReading: Record<string, unknown> | null;
  @ApiProperty({
    type: FxLiveSourcesDto,
    description: 'Last snapshot of each source (no network call).',
  })
  sources: FxLiveSourcesDto;
}

export class RefreshFxResponseDto extends FxStatusResponseDto {
  @ApiProperty({
    example: 'UPDATED',
    description: 'UPDATED | NOOP | MANUAL | REJECTED | FAILED | SKIPPED.',
  })
  result: string;
}

export class FxHistoryQueryDto {
  @ApiPropertyOptional({ enum: FxRateSource, enumName: 'FxRateSource' })
  @IsOptional()
  @IsEnum(FxRateSource)
  source?: FxRateSource;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: FX_HISTORY_MAX_LIMIT,
    default: FX_HISTORY_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FX_HISTORY_MAX_LIMIT)
  limit: number = FX_HISTORY_DEFAULT_LIMIT;
}

export class FxHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  source: FxRateSource;
  @ApiProperty({ example: '889.2600' })
  rate: string;
  @ApiProperty({ format: 'date-time' })
  providerUpdatedAt: string;
  @ApiProperty({ format: 'date-time' })
  fetchedAt: string;
}

export class FxHistoryResponseDto {
  @ApiProperty({ type: [FxHistoryItemDto] })
  data: FxHistoryItemDto[];
}

export class FxAuditQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: FX_AUDIT_MAX_LIMIT,
    default: FX_AUDIT_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FX_AUDIT_MAX_LIMIT)
  limit: number = FX_AUDIT_DEFAULT_LIMIT;
}

export class FxAuditAdminDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  email: string;
}

export class FxAuditItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ type: FxAuditAdminDto, nullable: true })
  admin: FxAuditAdminDto | null;
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  fromSource: FxRateSource;
  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  toSource: FxRateSource;
  @ApiProperty({ type: String, nullable: true, example: '912.5000' })
  manualRate: string | null;
  @ApiProperty({
    enum: FxSettingAction,
    enumName: 'FxSettingAction',
    description:
      'SETTINGS_UPDATED (PUT settings) | REJECTED_READING_ACCEPTED (accept-rejected).',
  })
  action: FxSettingAction;
  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class FxAuditMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
  @ApiProperty() hasNextPage: boolean;
  @ApiProperty() hasPreviousPage: boolean;
}

export class FxAuditResponseDto {
  @ApiProperty({ type: [FxAuditItemDto] })
  data: FxAuditItemDto[];
  @ApiProperty({ type: FxAuditMetaDto })
  meta: FxAuditMetaDto;
}
