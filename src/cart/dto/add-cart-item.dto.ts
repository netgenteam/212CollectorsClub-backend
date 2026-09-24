import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

/**
 * Story 3.1 (FR-8): body of `POST /api/v1/cart/items`. Malformed input
 * (non-UUID productId, non-positive/non-integer quantity) is rejected with
 * a stable 400 by the global `ValidationPipe` (NFR-3) before this ever
 * reaches CartController/CartService — the same "malformed input never
 * 500s" pattern Story 2.2/2.3 already established.
 */
export class AddCartItemDto {
  @ApiProperty({
    format: 'uuid',
    example: 'f65915f5-2931-4e50-af95-630b1fd7b950',
    description: 'Product id to add to the cart.',
  })
  @IsUUID()
  productId: string;

  @ApiProperty({
    minimum: 1,
    example: 1,
    description: 'Quantity to add (must be a positive integer).',
  })
  @IsInt()
  @Min(1)
  quantity: number;
}
