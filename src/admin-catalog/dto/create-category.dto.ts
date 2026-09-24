import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Story 8.1 (FR-23, AD-2). Body of `POST /api/v1/admin/categories`.
 *
 * `slug` is validated as a URL-safe token (lowercase letters, digits,
 * single hyphens between segments — the exact shape every seeded Category
 * slug already follows, e.g. "cartas-sueltas") purely as an input-quality
 * gate at the DTO layer (NFR-3: malformed input never reaches Prisma).
 * *Uniqueness* is a separate concern this DTO cannot enforce — `Category.
 * slug` is `@unique` at the DB level (Story 1.4) and
 * `AdminCategoriesService.create` translates a `P2002` violation on it into
 * a stable `409 CATEGORY_SLUG_TAKEN`, never a raw 500.
 */
export class CreateCategoryDto {
  @ApiProperty({
    example: 'Cartas Sueltas',
    description: 'Display name shown to storefront buyers.',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'cartas-sueltas',
    description:
      'URL-safe, unique slug: lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas"). Must not already be in use by another Category.',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens between segments (e.g. "cartas-sueltas")',
  })
  slug: string;
}
