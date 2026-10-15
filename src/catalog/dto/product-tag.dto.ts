import { ApiProperty } from '@nestjs/swagger';
import { CategoryDimension } from '../../generated/prisma/enums.js';

/** Story 13.5 (FR-50, AD-36): one taxonomy tag of a Product. */
export class ProductTagDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Pokémon' })
  name: string;

  @ApiProperty({ example: 'franchise-pokemon' })
  slug: string;

  @ApiProperty({
    enum: CategoryDimension,
    enumName: 'CategoryDimension',
    nullable: true,
  })
  dimension: CategoryDimension | null;
}
