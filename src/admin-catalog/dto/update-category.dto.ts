import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Story 8.1 (FR-23). Body of `PATCH /api/v1/admin/categories/:id`. Both
 * fields are optional (a partial update) — `name`-only and `slug`-only
 * requests are both legal; omitting both simply leaves the Category
 * unchanged. Same `slug` shape/uniqueness rules as `CreateCategoryDto` (see
 * its own doc comment) apply whenever `slug` IS supplied.
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({
    example: 'Cartas Sueltas Premium',
    description: 'New display name. Omit to leave the current name unchanged.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: 'cartas-sueltas-premium',
    description:
      'New URL-safe, unique slug (same shape as CreateCategoryDto.slug). Omit to leave the current slug unchanged.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas")',
  })
  slug?: string;
}
