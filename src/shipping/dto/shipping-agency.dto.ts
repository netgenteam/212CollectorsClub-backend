import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
  MinLength,
} from 'class-validator';

/** Public agency view: never exposes trackingUrlTemplate. */
export class ShippingAgencyPublicDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'MRW' })
  name: string;

  @ApiProperty({ example: 'mrw' })
  code: string;

  @ApiProperty()
  allowsOfficePickup: boolean;

  @ApiProperty()
  allowsHomeDelivery: boolean;
}

export class ShippingAgencyPublicListResponseDto {
  @ApiProperty({ type: [ShippingAgencyPublicDto] })
  data: ShippingAgencyPublicDto[];
}

export class ShippingAgencyAdminDto extends ShippingAgencyPublicDto {
  @ApiProperty()
  isActive: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://www.mrw.com.ve/track?n={trackingNumber}',
  })
  trackingUrlTemplate: string | null;

  @ApiProperty()
  sortOrder: number;
}

export class ShippingAgencyAdminListResponseDto {
  @ApiProperty({ type: [ShippingAgencyAdminDto] })
  data: ShippingAgencyAdminDto[];
}

/** PATCH body (strictBody): every field optional, at least one required. */
export class UpdateShippingAgencyDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowsOfficePickup?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowsHomeDelivery?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'https:// URL with exactly one {trackingNumber} marker; null clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  trackingUrlTemplate?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

/** POST body (strictBody). `code` is trimmed and upper-cased; immutable afterwards. */
export class CreateShippingAgencyDto {
  @ApiProperty({ maxLength: 80, example: 'Nueva Agencia' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiProperty({ pattern: '^[A-Z0-9_-]{2,50}$', example: 'NUEVA_AGENCIA' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,50}$/)
  code: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowsOfficePickup?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowsHomeDelivery?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  trackingUrlTemplate?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
