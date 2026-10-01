import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MarketProvider } from '../../generated/prisma/enums.js';

export const MARKET_REFERENCES_MAX = 20;

/** Story 11.4 (FR-34): one admin-supplied market reference. */
export class MarketReferenceInputDto {
  @ApiProperty({ enum: MarketProvider, enumName: 'MarketProvider' })
  @IsEnum(MarketProvider)
  provider: MarketProvider;

  @ApiProperty({ example: 'Cardmarket', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @ApiProperty({
    example: 'https://www.cardmarket.com/en/Pokemon',
    description:
      'Absolute https URL only (http:, javascript:, data:, etc. are rejected).',
  })
  @IsString()
  @MaxLength(2048)
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { message: 'url must be an absolute https URL' },
  )
  url: string;

  @ApiPropertyOptional({ example: 12.5, minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  suggestedPriceEur?: number;
}

/**
 * Parses `marketReferences` for both transports: JSON body (already an
 * array) and multipart create (a JSON-encoded string). Unparseable input is
 * left as-is so `@IsArray` rejects it with a 400.
 */
export const TransformMarketReferences = () =>
  Transform(({ value }: { value: unknown }) => {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return Array.isArray(parsed)
      ? plainToInstance(MarketReferenceInputDto, parsed as object[])
      : parsed;
  });

export function marketReferencesApiProperty() {
  return ApiPropertyOptional({
    type: MarketReferenceInputDto,
    isArray: true,
    description:
      'Optional market references. On PATCH, omitting it leaves existing references untouched; an array (including []) REPLACES all stored references in one transaction. On multipart create, send it as a JSON-encoded string.',
  });
}
