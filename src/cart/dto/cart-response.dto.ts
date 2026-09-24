import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 3.1 (FR-11): one line of `GET /api/v1/cart` / the response of
 * `POST /api/v1/cart/items`. `price`/`lineTotal` are always derived from
 * the Product's *current* `priceUsd` at read time (CartService), never a
 * value cached on the `CartItem` row at add-time — that's the whole point
 * of FR-11's "never a stale-cached price" AC.
 */
export class CartItemResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: 'f65915f5-2931-4e50-af95-630b1fd7b950',
  })
  productId: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  name: string;

  @ApiProperty({
    example: 2,
    description: 'Quantity of this Product in the cart.',
  })
  quantity: number;

  @ApiProperty({
    example: 89.99,
    description:
      "Product's current priceUsd, read fresh at request time (FR-11) — never a value stored on the CartItem row.",
  })
  price: number;

  @ApiProperty({
    example: 179.98,
    description: 'quantity * price, computed server-side.',
  })
  lineTotal: number;
}

/**
 * Story 3.1 (FR-8, FR-11): response of both `POST /api/v1/cart/items` and
 * `GET /api/v1/cart`. Deliberately never includes the cart's own id —
 * AD-5 keeps `cartId` out of anything client JS can read (only the
 * HttpOnly cookie carries it) specifically to avoid the XSS-hijack risk a
 * client-held cart token would have; echoing it back in a JSON body would
 * quietly reopen that same risk.
 */
export class CartResponseDto {
  @ApiProperty({ type: CartItemResponseDto, isArray: true })
  items: CartItemResponseDto[];

  @ApiProperty({
    example: 179.98,
    description:
      'Sum of every line lineTotal, computed server-side from current Product prices (FR-11).',
  })
  total: number;
}
