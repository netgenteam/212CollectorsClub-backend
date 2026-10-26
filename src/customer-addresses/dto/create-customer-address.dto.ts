import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const DELIVERY_MODES = ['agency_office', 'home_delivery'] as const;

/**
 * Story 17.2 (AD-72). Presence/format rules (FR-85) live in
 * `validateShippingInput` (400 SHIPPING_INVALID); the DTO only enforces
 * types and lengths (unknown fields are rejected by `strictBody`).
 */
export class CreateCustomerAddressDto {
  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  label?: string;

  @ApiProperty({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipientName: string;

  @ApiProperty({ example: '+58 412 123 4567', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  recipientPhone: string;

  @ApiProperty({ example: 'V-12345678', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  recipientIdDoc: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  agencyId: string;

  @ApiProperty({ enum: DELIVERY_MODES })
  @IsIn(DELIVERY_MODES)
  deliveryMode: (typeof DELIVERY_MODES)[number];

  @ApiPropertyOptional({
    maxLength: 150,
    description: 'Required for agency_office.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  agencyBranchName?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  agencyBranchCode?: string;

  @ApiProperty({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state: string;

  @ApiProperty({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  municipality: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parish?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Required for home_delivery.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  referencePoint?: string;
}
