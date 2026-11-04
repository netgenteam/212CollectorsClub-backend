import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CartCookieService } from '../cart/cart-cookie.service.js';
import {
  OptionalCustomer,
  OptionalCustomerGuard,
  type AuthenticatedCustomer,
} from '../common/customer-auth.guard.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';

@ApiTags('checkout')
@Controller('checkout')
@UseGuards(OptionalCustomerGuard)
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
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Check out the current cart (Pago Móvil or Stripe)',
    description:
      "Creates an Order from the caller's cart (identified by the signed cartId cookie; with a valid customer session cookie `cc_session` it is the ACCOUNT's cart instead, the order is linked to the account, and a verified email is required — Story 12.6; an invalid/expired session behaves as a guest), re-validating stock for every line at this exact moment (not the add-to-cart-time check). paymentRail=pago_movil (Story 4.1): an Order+OrderLines are created with a price/FX snapshot that is never recomputed, a StockHold is atomically reserved per line (AD-6), the Order enters pending_verification directly, and the response carries Pago Móvil payment instructions. paymentRail=stripe (Story 14.4/14.5b): no FX/VES snapshot, a StockHold is reserved per line (AD-50), the Order enters the transient payment_processing state, a Stripe Checkout Session is created server-side, and the response carries stripe.url to redirect the buyer to — the payment is later confirmed independently via POST /api/v1/payments/stripe/webhook, never by trusting the frontend. Delivery (the default; fulfillmentType=pickup is retired and answers 400 PICKUP_NOT_SUPPORTED) takes either the legacy flat address (addressLine1/city/state, accepted unless CHECKOUT_REQUIRE_SHIPPING=true, then 400 SHIPPING_REQUIRED) or the Epic 17 agency shipping format (customerAddressId for a logged-in customer, or shippingAgencyId + deliveryMode + recipientIdDoc + state + municipality ...); the shipping data is snapshotted on the order. Orthogonal to paymentRail. On success (either rail): the cart is cleared and the response carries a one-time orderAccessToken (only its hash is persisted server-side — save it, it is not recoverable later).",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'The created Order (price/FX snapshot for pago_movil, or a Stripe session for stripe) and the one-time orderAccessToken.',
    type: CheckoutResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Malformed body: invalid paymentRail/fulfillmentType, missing recipientName, or fulfillmentType=delivery with a missing address field.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode CONSENT_REQUIRED (Story 19.4, FR-114): acceptedTermsVersion / acceptedShippingVersion / acceptedReturnsVersion missing for a document that has a version in force; `details.missing[]`. Guests and accounts, both rails and the flat legacy format alike. No Order, StockHold or ConsentRecord is created.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode BUYER_ID_REQUIRED (Story 20.4, FR-127): neither `buyerId` nor `buyerSameAsRecipient` was sent while the server has CHECKOUT_REQUIRE_BUYER_ID=true; or `buyerLegalName` missing for a J/G buyer; or `buyerSameAsRecipient` in the legacy flat format / without a recipient cedula. errorCode BUYER_ID_INVALID: wrong type, length, characters or RIF check digit (RIF_CHECKDIGIT_STRICT), a non V/E recipient cedula to copy, or `buyerId` together with `buyerSameAsRecipient: true`. Both carry `details.field` (e.g. `buyerId.number`, `buyerLegalName`, `buyerSameAsRecipient`) and `details.reason` (REQUIRED, INVALID_TYPE, INVALID_FORMAT, INVALID_LENGTH, INVALID_CHECK_DIGIT, TOO_LONG, CONTAINS_ID_DOC (a cedula/RIF inside `buyerLegalName`: rejected, never cut; the buyer own RIF goes in `buyerId`), SAME_AS_RECIPIENT_NEEDS_AGENCY_FORMAT, RECIPIENT_ID_MISSING, RECIPIENT_ID_NOT_VE, CONFLICTS_WITH_BUYER_ID); never the value. Resolved before the transaction: no Order and no StockHold is created. errorCode SHIPPING_INVALID: `details.field` / `details.reason` are the first error (`details.errors[]` lists all), e.g. field recipientIdDoc, reason INVALID.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_CUSTOMER_TOKEN (Story 20.4/20.6): the account of the session was anonymized (or no longer exists) between the moment the session was read and the order. The first statement of the checkout transaction is `SELECT "anonymizedAt" ... FOR SHARE`, which waits for an anonymization in progress (`FOR UPDATE`) and then sees it. Nothing is created.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'errorCode EMPTY_CART — there is no cart cookie, or it resolves to an empty/expired cart.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode CHECKOUT_ACCOUNT_MISMATCH (Story 20.4): `expectedCustomerId` was sent and the session of this request is another account (or none; `null` expects a guest). Nothing is created. OR errorCode EMAIL_NOT_VERIFIED (Story 12.6) — a logged-in customer (cookie cc_session) whose email is not verified; no order and no stock hold are created. OR errorCode INSUFFICIENT_STOCK — one or more cart lines no longer have enough available stock. details.items lists every affected line with its requested/available quantities. The checkout is fully rejected — no Order is created. OR errorCode CONSENT_VERSION_STALE (Story 19.4): a version sent is not the one in force (or that document has none); `details.current{slug: versionNumber}`, `details.stale[]`; no Order is created.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_GATEWAY,
    description:
      'paymentRail=stripe only — errorCode STRIPE_SESSION_CREATION_FAILED: the Order was created but Stripe failed to create the Checkout Session; the Order is guardedly moved to payment_failed and its stock holds are released. Retry the checkout.',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'paymentRail=pago_movil only — errorCode FX_RATE_UNAVAILABLE (Story 18.3): the VES rate row is missing, <= 0, or older than maxAgeHours x 3 (non-MANUAL). No Order is created; Stripe is unaffected. OR errorCode LEGAL_NOT_PUBLISHED (Story 19.4, A75, either rail): LEGAL_REQUIRE_PUBLISHED=true and a required document (terminos / envios / devoluciones) has no version in force; `details.documents[]`; nothing is created.',
  })
  async checkout(
    @Body() dto: CheckoutDto,
    @OptionalCustomer() customer: AuthenticatedCustomer | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutResponseDto> {
    const cartId = this.cartCookie.readCartId(req);
    const response = await this.checkoutService.checkout(cartId, dto, customer);
    this.cartCookie.clearCartId(res);
    return response;
  }
}
