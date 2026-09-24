import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Story 10.1. Body of `PUT /api/v1/admin/landing-content/banners/{key}`.
 * A banner's 3 fields are always edited together as one JSON object
 * (`valueType = "json"`) — see `landing-content.constants.ts`'s doc comment
 * for why this is one row per banner rather than one row per field.
 *
 * `imageUrl`/`linkUrl` are kept as plain (non-`@IsUrl`) strings on purpose:
 * a banner image is typically served from this same API's own
 * `uploads/public/` static mount (a relative path, e.g.
 * "/uploads/public/landing/banner-1.jpg"), and `linkUrl` is commonly a
 * relative in-app path (e.g. "/productos?tag=nuevo") rather than an
 * absolute URL — `@IsUrl()`'s default strict-absolute-URL validation would
 * reject both of those legitimate shapes.
 */
export class UpdateLandingBannerDto {
  @ApiProperty({
    example: '/uploads/public/landing/banner-1.jpg',
    description:
      'Banner image location — an absolute URL or a path relative to this API (e.g. under uploads/public/).',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  imageUrl: string;

  @ApiProperty({
    example: 'Nuevo Drop 212 cada mes',
    description: 'Short banner headline/caption text.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    example: '/productos?tag=nuevo',
    description:
      'Where the banner links to when clicked — an absolute URL or a relative in-app path.',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  linkUrl: string;
}
