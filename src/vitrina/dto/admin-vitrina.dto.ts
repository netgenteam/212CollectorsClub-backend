import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export const VITRINA_PREVIEW_DEFAULT_SIZE = 8;
export const VITRINA_PREVIEW_MAX_PINNED = 12;

/** Weights as stored. Each 0..100 integer; the five must add up to exactly 100. */
export class UpdateVitrinaAlgorithmDto {
  @ApiProperty({ minimum: 0, maximum: 100, example: 40 })
  @IsInt()
  @Min(0)
  @Max(100)
  wSales: number;
  @ApiProperty({ minimum: 0, maximum: 100, example: 15 })
  @IsInt()
  @Min(0)
  @Max(100)
  wRevenue: number;
  @ApiProperty({ minimum: 0, maximum: 100, example: 15 })
  @IsInt()
  @Min(0)
  @Max(100)
  wVelocity: number;
  @ApiProperty({ minimum: 0, maximum: 100, example: 20 })
  @IsInt()
  @Min(0)
  @Max(100)
  wInterest: number;
  @ApiProperty({ minimum: 0, maximum: 100, example: 10 })
  @IsInt()
  @Min(0)
  @Max(100)
  wNovelty: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 90, example: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  halfLifeDays?: number;
  @ApiPropertyOptional({
    minimum: 14,
    maximum: 365,
    example: 90,
    description: 'Must be >= halfLifeDays (400 VITRINA_PARAMS_INVALID).',
  })
  @IsOptional()
  @IsInt()
  @Min(14)
  @Max(365)
  windowDays?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 90, example: 21 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  noveltyDays?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 12, example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  maxPerFranchise?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.35 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1)
  mmrLambda?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 50, example: 3 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(50)
  priorM?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'true recomputes right after saving (outside the save transaction). The save never depends on it.',
  })
  @IsOptional()
  @IsBoolean()
  recompute?: boolean;
}

export class VitrinaRunSummaryDto {
  @ApiProperty({ format: 'uuid' })
  runId: string;
  @ApiProperty({ format: 'date-time' })
  computedAt: string;
  @ApiProperty({ enum: ['RANKED', 'FALLBACK'] })
  mode: string;
  @ApiProperty({ description: 'Units sold inside the window.' })
  salesCount: number;
}

export class VitrinaAlgorithmResponseDto {
  @ApiProperty() wSales: number;
  @ApiProperty() wRevenue: number;
  @ApiProperty() wVelocity: number;
  @ApiProperty() wInterest: number;
  @ApiProperty() wNovelty: number;
  @ApiProperty() halfLifeDays: number;
  @ApiProperty() windowDays: number;
  @ApiProperty() noveltyDays: number;
  @ApiProperty() maxPerFranchise: number;
  @ApiProperty() mmrLambda: number;
  @ApiProperty() priorM: number;
  @ApiProperty({ description: 'Read-only constant.' })
  scarcityThreshold: number;
  @ApiProperty({ description: 'Read-only constant.' })
  minSalesForRanking: number;
  @ApiProperty({ description: 'Read-only constant.' }) viewDayCap: number;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  currentRunId: string | null;
  @ApiProperty({ type: VitrinaRunSummaryDto, nullable: true })
  lastRun: VitrinaRunSummaryDto | null;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  updatedById: string | null;
}

export class VitrinaRecomputeStatusDto {
  @ApiProperty({
    enum: ['NOT_REQUESTED', 'DONE', 'IN_PROGRESS', 'FAILED'],
    description:
      'Outcome of the optional recompute. IN_PROGRESS/FAILED never undo the saved settings.',
  })
  status: string;
  @ApiProperty({ type: VitrinaRunSummaryDto, nullable: true })
  run: VitrinaRunSummaryDto | null;
}

export class UpdateVitrinaAlgorithmResponseDto extends VitrinaAlgorithmResponseDto {
  @ApiProperty({ type: VitrinaRecomputeStatusDto })
  recompute: VitrinaRecomputeStatusDto;
}

export class VitrinaPreviewQueryDto {
  @ApiPropertyOptional({ enum: ['MANUAL', 'AUTO', 'MIXED'], default: 'AUTO' })
  @IsOptional()
  @IsIn(['MANUAL', 'AUTO', 'MIXED'])
  mode: 'MANUAL' | 'AUTO' | 'MIXED' = 'AUTO';

  @ApiPropertyOptional({
    minimum: 4,
    maximum: 12,
    default: VITRINA_PREVIEW_DEFAULT_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(12)
  size: number = VITRINA_PREVIEW_DEFAULT_SIZE;

  @ApiPropertyOptional({
    type: String,
    description: `Comma-separated product ids (max ${VITRINA_PREVIEW_MAX_PINNED}), kept first in MANUAL/MIXED.`,
    example: '3f2c...,9a1b...',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(VITRINA_PREVIEW_MAX_PINNED)
  @IsUUID('all', { each: true })
  pinned: string[] = [];
}

export class VitrinaPreviewItemDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['pinned', 'auto'] }) source: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Position in the current run (after MMR); null if unranked.',
  })
  rank: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 61.2345 })
  score: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'TOP_SALES | TRENDING | NEW_WITH_TRACTION | WISHLIST_FAVORITE | NEW | null',
  })
  reason: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Breakdown: sales/revenue/velocity/interest {raw,z,zSmoothed,weight,points}, novelty {raw,weight,points}, scarcityFactor, score. sum(points) * scarcityFactor == score (4 dp).',
  })
  components: Record<string, unknown> | null;
}

export class VitrinaPreviewResponseDto {
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  computedAt: string | null;
  @ApiProperty({ enum: ['RANKED', 'FALLBACK'], nullable: true, type: String })
  runMode: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  runId: string | null;
  @ApiProperty({ type: [VitrinaPreviewItemDto] })
  items: VitrinaPreviewItemDto[];
}

export const VITRINA_AUDIT_DEFAULT_LIMIT = 20;
export const VITRINA_AUDIT_MAX_LIMIT = 100;

export class VitrinaAuditQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: VITRINA_AUDIT_MAX_LIMIT,
    default: VITRINA_AUDIT_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VITRINA_AUDIT_MAX_LIMIT)
  limit: number = VITRINA_AUDIT_DEFAULT_LIMIT;
}

export class VitrinaAuditAdminDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  email: string;
}

export class VitrinaAuditItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ format: 'date-time' })
  createdAt: string;
  @ApiProperty({ type: VitrinaAuditAdminDto, nullable: true })
  admin: VitrinaAuditAdminDto | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  before: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true })
  after: Record<string, unknown>;
}

export class VitrinaAuditMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
  @ApiProperty() hasNextPage: boolean;
  @ApiProperty() hasPreviousPage: boolean;
}

export class VitrinaAuditResponseDto {
  @ApiProperty({ type: [VitrinaAuditItemDto] })
  data: VitrinaAuditItemDto[];
  @ApiProperty({ type: VitrinaAuditMetaDto })
  meta: VitrinaAuditMetaDto;
}
