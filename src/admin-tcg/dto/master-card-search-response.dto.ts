import { ApiProperty } from '@nestjs/swagger';
import { Franchise, ProductLanguage } from '../../generated/prisma/enums.js';
import { PaginationMetaDto } from '../../catalog/dto/paginated-products-response.dto.js';

/** Story 15.5 (FR-68, AD-56, A35). One master card (one entry per printing). */
export class MasterCardSearchItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '12345', description: 'Provider card id.' })
  externalId: string;

  @ApiProperty({ example: 'Charizard ex' })
  name: string;

  @ApiProperty({ enum: Franchise, enumName: 'Franchise' })
  franchise: Franchise;

  @ApiProperty({ example: 'sv3pt5' })
  setId: string;

  @ApiProperty({ example: '151' })
  setName: string;

  @ApiProperty({ nullable: true, type: String, example: '199/165' })
  cardNumber: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Raw API rarity.' })
  rarity: string | null;

  @ApiProperty({ enum: ProductLanguage, enumName: 'ProductLanguage' })
  editionLanguage: ProductLanguage;

  @ApiProperty({ nullable: true, type: String })
  imageSmall: string | null;

  @ApiProperty({ nullable: true, type: String })
  imageLarge: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 12.5,
    description: 'Provider market price in USD; null when unpriced.',
  })
  apiPriceUsd: number | null;

  @ApiProperty({
    example: true,
    description: 'At least one Product (active or not) is linked.',
  })
  alreadyInInventory: boolean;

  @ApiProperty({
    example: 7,
    description: 'Sum of raw `stock` over every linked Product (0 if none).',
  })
  currentInventoryStock: number;
}

export class MasterCardSearchResponseDto {
  @ApiProperty({ type: [MasterCardSearchItemDto] })
  data: MasterCardSearchItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
