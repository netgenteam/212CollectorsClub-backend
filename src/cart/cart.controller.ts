import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CartCookieService } from './cart-cookie.service.js';
import { CartService } from './cart.service.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { CartResponseDto } from './dto/cart-response.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';

@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(
    private readonly cartService: CartService,
    private readonly cartCookie: CartCookieService,
  ) {}

  /**
   * Story 3.1 (FR-8, AD-5): adds a Product/quantity to the guest Cart
   * identified by the request's signed `cartId` cookie, creating a new
   * Cart (and setting that cookie) when there wasn't a valid one. Returns
   * the full, current Cart state (same shape as `GET /cart`) so the caller
   * doesn't need a second request just to see the effect of this one.
   * Rejects with `409 INSUFFICIENT_STOCK` (current available stock in
   * `details.availableStock`) rather than clamping or silently accepting
   * a quantity above what's available.
   */
  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a product to the cart',
    description:
      "Adds productId/quantity to the caller's cart (identified by the signed cartId cookie), creating a new cart + cookie when none exists. Re-adding a product already in the cart increases its quantity on the same line rather than adding a duplicate line. Returns the full updated cart. Rejects with 409 INSUFFICIENT_STOCK when the total desired quantity exceeds the product's current available stock (stock - heldQty).",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'The updated cart, with server-computed line/total prices.',
    type: CartResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Product exists with the given productId.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode INSUFFICIENT_STOCK — the requested quantity (plus whatever of this product is already in the cart) exceeds current available stock. details.availableStock carries the real current value.',
  })
  async addItem(
    @Body() dto: AddCartItemDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartResponseDto> {
    const existingCartId = this.cartCookie.readCartId(req);
    const { cartId } = await this.cartService.addItem(existingCartId, dto);
    this.cartCookie.writeCartId(res, cartId);
    return this.cartService.getCart(cartId);
  }

  /**
   * Story 3.1 (FR-11): returns every CartItem in the caller's cart plus a
   * total computed server-side from each Product's *current* priceUsd —
   * never a price cached at add-to-cart time. No cart cookie (missing,
   * unverifiable, or pointing at an expired/nonexistent Cart) returns an
   * empty cart (`{ items: [], total: 0 }`) with 200, not an error — a
   * guest who hasn't added anything yet is not an error condition.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'View the current cart',
    description:
      "Returns every item in the caller's cart (identified by the signed cartId cookie) plus a total computed server-side from each product's current price. No valid cart cookie returns an empty cart (200), never an error.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The current cart (empty when there is no valid cart cookie).',
    type: CartResponseDto,
  })
  getCart(@Req() req: Request): Promise<CartResponseDto> {
    const cartId = this.cartCookie.readCartId(req);
    return this.cartService.getCart(cartId);
  }

  /**
   * Story 3.2 (FR-9, AD-5): updates the quantity of a Product already in
   * the caller's cart. A quantity of 0 removes the line entirely (same
   * effect Story 3.3's dedicated DELETE endpoint will have — not built
   * here, see CartService.updateItemQuantity for the full reasoning).
   * 404s when there's no valid cart cookie, or the productId isn't a line
   * in that cart — see CartService for why. Rejects with
   * `409 INSUFFICIENT_STOCK` (current available stock in
   * `details.availableStock`) when the new quantity exceeds live available
   * stock; the cart is left untouched on that rejection. Returns the full
   * updated cart (same shape as `GET /cart`), same pattern as `POST
   * /cart/items`.
   */
  @Patch('items/:productId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a cart item quantity',
    description:
      "Sets a new quantity for a Product already in the caller's cart (identified by the signed cartId cookie). quantity=0 removes the line entirely. Rejects with 409 INSUFFICIENT_STOCK when the new quantity exceeds current available stock (stock - heldQty) — the cart is left unmodified. 404s when there's no valid cart cookie or the product isn't a line in that cart. Returns the full updated cart.",
  })
  @ApiParam({ name: 'productId', format: 'uuid', description: 'Product id.' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The updated cart, with server-computed line/total prices.',
    type: CartResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'No valid cart cookie, or the given productId is not a line in that cart.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode INSUFFICIENT_STOCK — the requested quantity exceeds current available stock. details.availableStock carries the real current value. The cart is left unmodified.',
  })
  async updateItem(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    const cartId = this.cartCookie.readCartId(req);
    await this.cartService.updateItemQuantity(cartId, productId, dto.quantity);
    return this.cartService.getCart(cartId);
  }
}
