import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PACK_TIERS, type PackTier } from '../pack-tiers.js';
import { IsPriceUsd, PRICE_USD_MAX } from './price-usd.validator.js';
import { IsSimulatorImageUrl } from './image-url.validator.js';
import { PageMetaDto } from './manual-sets.dto.js';

export const CARDS_MAX_LIMIT = 100;
export const CARDS_DEFAULT_LIMIT = 50;
export const CARD_NAME_MAX = 120;
export const CARD_NUMBER_MAX = 30;
export const PRICE_MAX = PRICE_USD_MAX; // Decimal(10,2)

// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/;
const trimStr = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
/** `number`: trimmed; empty / whitespace-only becomes `null` (AC2). */
const numberTransform = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t.length === 0 ? null : t;
};
const notUndefined = (_: unknown, v: unknown): boolean => v !== undefined;
const notNullish = (_: unknown, v: unknown): boolean =>
  v !== undefined && v !== null;

export class CardsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: CARDS_MAX_LIMIT,
    default: CARDS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CARDS_MAX_LIMIT)
  limit: number = CARDS_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: PACK_TIERS })
  @IsOptional()
  @IsIn(PACK_TIERS)
  tier?: PackTier;

  @ApiPropertyOptional({
    maxLength: CARD_NAME_MAX,
    description: 'Case-insensitive name search; % and _ are literals.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CARD_NAME_MAX)
  q?: string;
}

export class CreateManualCardDto {
  @ApiProperty({ minLength: 1, maxLength: CARD_NAME_MAX })
  @Transform(trimStr)
  @IsString()
  @MinLength(1)
  @MaxLength(CARD_NAME_MAX)
  @Matches(NO_NUL, { message: 'name must not contain NUL characters' })
  name: string;

  @ApiProperty({ enum: PACK_TIERS })
  @IsIn(PACK_TIERS)
  rarityTier: PackTier;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: CARD_NUMBER_MAX,
    description: 'Collector number; empty / spaces become null.',
  })
  @Transform(numberTransform)
  @ValidateIf(notNullish)
  @IsString()
  @MaxLength(CARD_NUMBER_MAX)
  @Matches(NO_NUL, { message: 'number must not contain NUL characters' })
  number?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @ValidateIf(notNullish)
  @IsSimulatorImageUrl()
  imageUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: PRICE_MAX,
    description: 'USD, up to 2 decimals (JSON number).',
  })
  @ValidateIf(notNullish)
  @IsPriceUsd()
  marketPriceUsd?: number | null;
}

export class UpdateManualCardDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: CARD_NAME_MAX })
  @Transform(trimStr)
  @ValidateIf(notUndefined)
  @IsString()
  @MinLength(1)
  @MaxLength(CARD_NAME_MAX)
  @Matches(NO_NUL, { message: 'name must not contain NUL characters' })
  name?: string;

  @ApiPropertyOptional({ enum: PACK_TIERS })
  @ValidateIf(notUndefined)
  @IsIn(PACK_TIERS)
  rarityTier?: PackTier;

  @ApiPropertyOptional({ nullable: true, maxLength: CARD_NUMBER_MAX })
  @Transform(numberTransform)
  @ValidateIf(notNullish)
  @IsString()
  @MaxLength(CARD_NUMBER_MAX)
  @Matches(NO_NUL, { message: 'number must not contain NUL characters' })
  number?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @ValidateIf(notNullish)
  @IsSimulatorImageUrl()
  imageUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: PRICE_MAX,
  })
  @ValidateIf(notNullish)
  @IsPriceUsd()
  marketPriceUsd?: number | null;
}

export class CardDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) setId: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: PACK_TIERS }) rarityTier: PackTier;
  @ApiProperty({ nullable: true, type: String }) number: string | null;
  @ApiProperty({ nullable: true, type: String }) imageUrl: string | null;
  @ApiProperty({ nullable: true, type: Number }) marketPriceUsd: number | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CardListDto {
  @ApiProperty({ type: [CardDto] }) data: CardDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}
