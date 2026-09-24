import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/**
 * Story 3.2 (FR-9): body of `PATCH /api/v1/cart/items/{productId}`.
 * Deliberately `@Min(0)` — unlike `AddCartItemDto`'s `@Min(1)` (you can't
 * "add" a non-positive amount), a quantity of exactly 0 here is a valid,
 * meaningful request: per this story's AC it means "remove this line from
 * the cart entirely" (the same effect Story 3.3's dedicated DELETE
 * endpoint will have), not a validation error. Anything negative or
 * non-integer is still rejected with a stable 400 by the global
 * `ValidationPipe` (NFR-3) before this ever reaches CartController/
 * CartService, same pattern Story 3.1 established.
 */
export class UpdateCartItemDto {
  @ApiProperty({
    minimum: 0,
    example: 3,
    description:
      'New quantity for this cart line. 0 removes the item from the cart entirely.',
  })
  @IsInt()
  @Min(0)
  quantity: number;
}
