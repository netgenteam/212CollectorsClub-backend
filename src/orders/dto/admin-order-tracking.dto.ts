import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

/**
 * Story 17.5 (AD-76): body of `PATCH /admin/orders/:orderId/tracking`.
 * Shape checks (type, trim, regex) live in the service so every failure is the
 * single code `TRACKING_NUMBER_INVALID`; `null`/`""` clears the number.
 */
export class UpdateOrderTrackingDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'MRW0012345',
    description:
      'Trimmed, ^[A-Za-z0-9._/-]{3,64}$. null or "" removes the tracking number.',
  })
  @IsOptional()
  trackingNumber?: string | null;
}

export class AdminOrderTrackingResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ nullable: true, type: String, example: 'MRW0012345' })
  trackingNumber: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'https://agency.example/track?n=MRW0012345',
  })
  trackingUrl: string | null;
}
