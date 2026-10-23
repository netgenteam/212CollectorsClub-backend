import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  LINK_HREF_PATTERN,
  LinkDto,
  SEGMENT_STYLES,
  SegmentDto,
  TITLE_LINES_MAX_LINES,
  type SegmentStyle,
} from './common.dto.js';

/**
 * Story 16.1 (AD-60). The seven typed `home/*` block shapes, exactly as the
 * architecture fixes them. `titleLines` (`Segment[][]`, 1..4 lines x 1..4
 * segments) only has its OUTER array shape checked by decorators here —
 * class-validator cannot recurse into array-of-arrays, so the per-line /
 * per-segment rules run in `landing-blocks.validation.ts` and surface with
 * the same `panels.0.titleLines.1.0.text` style paths.
 */

// ---- ticker ---------------------------------------------------------------

export class TickerItemDto {
  @ApiProperty({ minLength: 1, maxLength: 140 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  text: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  accent?: string;
}

export class TickerBlockDto {
  @ApiProperty({ type: [TickerItemDto], minItems: 1, maxItems: 12 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => TickerItemDto)
  items: TickerItemDto[];
}

// ---- hero -----------------------------------------------------------------

export class HeroPanelDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  eyebrow?: string;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: { $ref: '#/components/schemas/SegmentDto' },
    },
    minItems: 1,
    maxItems: 4,
    description: 'TitleLine[] — 1..4 lines of 1..4 { text, style } segments.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TITLE_LINES_MAX_LINES)
  titleLines: SegmentDto[][];

  @ApiPropertyOptional({ minLength: 1, maxLength: 300 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ type: [LinkDto], maxItems: 2 })
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => LinkDto)
  ctas: LinkDto[];
}

export class HeroBlockDto {
  @ApiProperty({ type: [HeroPanelDto], minItems: 3, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => HeroPanelDto)
  panels: HeroPanelDto[];
}

// ---- heroScene ------------------------------------------------------------

/** `/img/<file>.(webp|png|jpg|avif)` or `/uploads/public/landing/<uuid>.<ext>` (shape only; existence on disk is Story 16.2). */
export const HERO_SCENE_URL_PATTERN =
  /^(\/img\/[A-Za-z0-9._-]+\.(webp|png|jpg|avif)|\/uploads\/public\/landing\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg|avif))$/;

export class HeroSceneBlockDto {
  @ApiProperty({ maxLength: 300, example: '/img/pack.webp' })
  @IsString()
  @MaxLength(300)
  packImageUrl: string;

  @ApiProperty({ type: [String], minItems: 3, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  cardImageUrls: string[];
}

// ---- manifesto ------------------------------------------------------------

export class ManifestoItemDto {
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  text: string;

  @ApiProperty({ enum: SEGMENT_STYLES })
  @IsIn(SEGMENT_STYLES)
  style: SegmentStyle;
}

export class ManifestoBlockDto {
  @ApiProperty({ type: [ManifestoItemDto], minItems: 1, maxItems: 8 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ManifestoItemDto)
  items: ManifestoItemDto[];
}

// ---- vitrina --------------------------------------------------------------

export class VitrinaBlockDto {
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  eyebrow: string;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: { $ref: '#/components/schemas/SegmentDto' },
    },
    minItems: 1,
    maxItems: 4,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TITLE_LINES_MAX_LINES)
  titleLines: SegmentDto[][];

  @ApiProperty({ minLength: 1, maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  ctaLabel: string;

  @ApiProperty({
    type: [String],
    maxItems: 12,
    description: 'Product UUIDs, no repeats.',
  })
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  productIds: string[];
}

// ---- drop212 --------------------------------------------------------------

export class Drop212TierDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: 'tier-1' })
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'id must be a lowercase slug',
  })
  id: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  tier: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: 400 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  body: string;

  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  cta: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Link.href rules; the frontend defaults to /catalogo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(LINK_HREF_PATTERN, {
    message:
      'ctaHref must be a root-relative path (not "//host"), an "#anchor" or an absolute https:// URL',
  })
  ctaHref?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @ApiPropertyOptional({ minLength: 1, maxLength: 30 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  featuredLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ctaMagenta?: boolean;
}

export class Drop212BlockDto {
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  eyebrow: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  caption: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Real ISO-8601 date-time or null/absent (the frontend then keeps the relative countdown).',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  targetDate?: string | null;

  @ApiProperty({ type: [Drop212TierDto], maxItems: 6 })
  @IsArray()
  @ArrayMaxSize(6)
  @ArrayUnique((t: Drop212TierDto) => t?.id)
  @ValidateNested({ each: true })
  @Type(() => Drop212TierDto)
  tiers: Drop212TierDto[];
}

// ---- simulator ------------------------------------------------------------

export class SimulatorBlockDto {
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  eyebrow: string;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: { $ref: '#/components/schemas/SegmentDto' },
    },
    minItems: 1,
    maxItems: 4,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TITLE_LINES_MAX_LINES)
  titleLines: SegmentDto[][];

  @ApiProperty({ minLength: 1, maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description: string;

  @ApiProperty({ minLength: 1, maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  ctaLabel: string;
}
