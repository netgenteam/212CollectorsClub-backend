import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { PageMeta } from '../../common/pagination.js';
import { PACK_TIERS, type PackTier } from '../pack-tiers.js';
import type { ReadinessSlot } from './readiness.js';
import { IsSimulatorImageUrl } from './image-url.validator.js';

export const SETS_MAX_LIMIT = 100;
export const SETS_DEFAULT_LIMIT = 20;

export class ManualSetsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SETS_MAX_LIMIT,
    default: SETS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SETS_MAX_LIMIT)
  limit: number = SETS_DEFAULT_LIMIT;

  @ApiPropertyOptional({ description: 'Filter by isActive (true|false).' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Case-insensitive name search (max 120).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class CreateManualSetDto {
  @ApiProperty({ maxLength: 120, example: 'Base Set 151' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @IsOptional()
  @IsSimulatorImageUrl()
  imageUrl?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Pack template; defaults to a copy of the `pokemon` template.',
  })
  @Allow()
  template?: unknown;
}

export class UpdateManualSetDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @IsOptional()
  @IsSimulatorImageUrl()
  imageUrl?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @Allow()
  template?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MissingItemDto {
  @ApiProperty({
    example: 'fixed:COMMON',
    description: 'fixed:<TIER> | reverse | rare:<TIER>',
  })
  slot: ReadinessSlot;
  @ApiProperty({ nullable: true, enum: PACK_TIERS, type: String })
  tier: PackTier | null;
  @ApiProperty()
  required: number;
  @ApiProperty()
  available: number;
}

export class ReadinessDto {
  @ApiProperty()
  ready: boolean;
  @ApiProperty({ type: [MissingItemDto] })
  missing: MissingItemDto[];
  @ApiPropertyOptional({ enum: ['TEMPLATE_INVALID'] })
  reason?: 'TEMPLATE_INVALID';
}

export class SetDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  name: string;
  @ApiProperty({ nullable: true, type: String })
  imageUrl: string | null;
  @ApiProperty()
  isActive: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true })
  template: unknown;
  @ApiProperty()
  cardCount: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'One key per rarity tier (8).',
  })
  cardCountByTier: Record<PackTier, number>;
  @ApiProperty({ type: ReadinessDto })
  readiness: ReadinessDto;
  @ApiProperty()
  createdAt: Date;
  @ApiProperty()
  updatedAt: Date;
}

export class PageMetaDto implements PageMeta {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
  @ApiProperty() hasNextPage: boolean;
  @ApiProperty() hasPreviousPage: boolean;
}

export class SetListDto {
  @ApiProperty({ type: [SetDto] })
  data: SetDto[];
  @ApiProperty({ type: PageMetaDto })
  meta: PageMetaDto;
}
