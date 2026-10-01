import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarketProvider } from '../../generated/prisma/enums.js';

/** Story 11.4 (FR-34): one external market reference on a product detail. */
export class MarketReferenceDto {
  @ApiProperty({ enum: MarketProvider, enumName: 'MarketProvider' })
  provider: MarketProvider;

  @ApiProperty({ example: 'Cardmarket' })
  label: string;

  @ApiProperty({ example: 'https://www.cardmarket.com/en/Pokemon/Products' })
  url: string;

  @ApiPropertyOptional({
    example: 12.5,
    description: 'Suggested price in EUR; omitted when unknown.',
  })
  suggestedPriceEur?: number;
}
