import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Franchise } from '../../generated/prisma/enums.js';

export const MASTER_CARD_SEARCH_DEFAULT_PAGE = 1;
export const MASTER_CARD_SEARCH_DEFAULT_LIMIT = 20;
export const MASTER_CARD_SEARCH_MAX_LIMIT = 50;

/** Story 15.5 (FR-68, AD-56). Query of `GET /admin/tcg-master-cards/search`. */
export class SearchMasterCardsQueryDto {
  @ApiPropertyOptional({
    maxLength: 200,
    example: 'charizard ex 199/165',
    description:
      'Free text over name + set + number, accent- and case-insensitive. Split by whitespace/punctuation; EVERY token must match.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: Franchise, enumName: 'Franchise' })
  @IsOptional()
  @IsEnum(Franchise)
  franchise?: Franchise;

  @ApiPropertyOptional({
    maxLength: 100,
    example: 'sv3pt5',
    description: 'Exact setId OR part of the set name (case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  set?: string;

  @ApiPropertyOptional({
    minimum: 1,
    default: MASTER_CARD_SEARCH_DEFAULT_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = MASTER_CARD_SEARCH_DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MASTER_CARD_SEARCH_MAX_LIMIT,
    default: MASTER_CARD_SEARCH_DEFAULT_LIMIT,
    description: `Items per page (max ${MASTER_CARD_SEARCH_MAX_LIMIT}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MASTER_CARD_SEARCH_MAX_LIMIT)
  limit: number = MASTER_CARD_SEARCH_DEFAULT_LIMIT;
}
