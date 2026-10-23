import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const INGEST_MAX_REQUESTS_CAP = 500;
export const INGEST_SET_LIMIT_CAP = 100;

/**
 * Story 15.9 (AD-55/AD-56). Body of `POST /admin/tcg-master-cards/ingest`.
 * Every field is optional: a missing one falls back to the `TCG_*` env
 * defaults, exactly like the `pnpm tcg:ingest` CLI. There is no `dryRun`.
 */
export class StartIngestDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['pokemon'],
    description: 'tcgapi.dev game slugs. Default: TCG_INGEST_GAMES.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  games?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['sv3pt5'],
    description:
      'Set ids or slugs. Default: TCG_INGEST_SETS, else the `setLimit` newest sets per game.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  sets?: string[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: INGEST_MAX_REQUESTS_CAP,
    description:
      'Request budget of this run. Default: TCG_MAX_REQUESTS_PER_RUN.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INGEST_MAX_REQUESTS_CAP)
  maxRequests?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: INGEST_SET_LIMIT_CAP,
    description:
      'Newest sets per game when `sets` is not given. Default: TCG_INGEST_DEFAULT_SET_LIMIT.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INGEST_SET_LIMIT_CAP)
  setLimit?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Cards to store in this run. Values above the server cap TCG_REMOTE_INGEST_MAX_CARDS (default 10) are clamped down to it (not rejected). The run ends PARTIAL with summary.cardCapReached when the cap stops it; the next run continues.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxCards?: number;

  @ApiPropertyOptional({ description: 'Re-read the set list from tcgapi.dev.' })
  @IsOptional()
  @IsBoolean()
  refreshSets?: boolean;
}
