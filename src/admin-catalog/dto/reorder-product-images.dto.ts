import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Story 12.1 (FR-39): desired order of a Product's images. The permutation
 * check against the Product's current images happens in the service, under
 * the parent-row lock. */
export class ReorderProductImagesDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    isArray: true,
    description:
      'Every current image id of the Product exactly once, in the desired order (first = primary).',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  imageIds: string[];
}
