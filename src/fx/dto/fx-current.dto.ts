import { ApiProperty } from '@nestjs/swagger';
import { FxRateSource } from '../../generated/prisma/enums.js';

/** Story 18.3 (AD-80, FR-94): public current VES rate. */
export class FxCurrentResponseDto {
  @ApiProperty({
    type: String,
    example: '889.2600',
    description:
      'VES per 1 unit of the source currency, decimal string (4 dp).',
  })
  vesPerUsd: string;

  @ApiProperty({ enum: FxRateSource, enumName: 'FxRateSource' })
  source: FxRateSource;

  @ApiProperty({
    format: 'date-time',
    description: 'providerUpdatedAt ?? rateFetchedAt (ISO).',
  })
  updatedAt: string;

  @ApiProperty({
    description:
      'True when the rate is older than maxAgeHours (never for MANUAL). Past maxAgeHours x 3 the endpoint answers 503 instead.',
  })
  stale: boolean;
}
