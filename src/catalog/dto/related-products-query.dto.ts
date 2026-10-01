import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const RELATED_DEFAULT_LIMIT = 4;
export const RELATED_MAX_LIMIT = 10;

/** Story 11.3 (FR-33): query params for `GET /products/:id/related`. */
export class RelatedProductsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: RELATED_MAX_LIMIT,
    default: RELATED_DEFAULT_LIMIT,
    description: 'Max related products to return.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RELATED_MAX_LIMIT)
  limit: number = RELATED_DEFAULT_LIMIT;
}
