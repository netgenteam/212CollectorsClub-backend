import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CartCookieService } from '../cart/cart-cookie.service.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';

@ApiTags('checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly cartCookie: CartCookieService,
  ) {}

  /**
   * Story 4.1 (FR-12, FR-13, FR-15 creation portion). Identifies the
   * caller's cart via the same signed `cartId` cookie `CartController`
   * uses (AD-5) — never a body field. On success, the Cart is fully
   * cleared server-side (CheckoutService) and the now-stale cookie is
   * cleared here too (see CartCookieService.clearCartId's doc comment).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Check out the current cart (Pago Móvil or PayPal)',
    description:
      "Creates an Order from the caller's cart (identified by the signed cartId cookie), re-validating stock for every line at this exact moment (not the add-to-cart-time check). paymentRail=pago_movil (Story 4.1): an Order+OrderLines are created with a price/FX snapshot that is never recomputed, a StockHold is atomically reserved per line (AD-6), the Order enters pending_verification directly, and the response carries Pago Móvil payment instructions. paymentRail=paypal (Story 4.3): no FX/VES snapshot, no StockHold (a paypal Order never holds stock), the Order enters the transient payment_processing state, a PayPal order/session is created server-side, and the response carries paypal.approveUrl to redirect the buyer to — the payment is later confirmed independently via POST /api/v1/payments/paypal/webhook, never by trusting the frontend. fulfillmentType=delivery requires a full Venezuela address (addressLine1/city/state); fulfillmentType=pickup requires none of it — orthogonal to paymentRail. On success (either rail): the cart is cleared and the response carries a one-time orderAccessToken (only its hash is persisted server-side — save it, it is not recoverable later).",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'The created Order (price/FX snapshot for pago_movil, or a PayPal session for paypal) and the one-time orderAccessToken.',
    type: CheckoutResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Malformed body: invalid paymentRail/fulfillmentType, missing recipientName, or fulfillmentType=delivery with a missing address field.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'errorCode EMPTY_CART — there is no cart cookie, or it resolves to an empty/expired cart.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode INSUFFICIENT_STOCK — one or more cart lines no longer have enough available stock. details.items lists every affected line with its requested/available quantities. The checkout is fully rejected — no Order is created.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_GATEWAY,
    description:
      'paymentRail=paypal only — errorCode PAYPAL_ORDER_CREATION_FAILED: the Order was created but PayPal itself failed to create its own order/session for it; the Order is guardedly moved to payment_failed. Retry the checkout.',
  })
  async checkout(
    @Body() dto: CheckoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutResponseDto> {
    const cartId = this.cartCookie.readCartId(req);
    const response = await this.checkoutService.checkout(cartId, dto);
    this.cartCookie.clearCartId(res);
    return response;
  }
}
