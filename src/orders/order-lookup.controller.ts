import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';
import type { RequestWithOrder } from './order-access-token.guard.js';
import { OrderLookupService } from './order-lookup.service.js';
import {
  OrderDetailResponseDto,
  OrderStatusHistoryEntryDto,
} from './dto/order-lookup-response.dto.js';

/**
 * Story 5.1 (FR-13 retrievability, FR-17; AD-17, AD-7). Two read-only
 * routes under `orders/:orderId`, both gated by the exact same
 * `OrderAccessTokenGuard` Story 4.2 introduced for the proof-of-payment
 * routes — never re-implemented here (see that guard's own doc comment,
 * which already named this exact future route when it was written).
 *
 * **Design choice: two routes, not one.** AC2 explicitly allows folding
 * the transition history into the same response as AC1's status lookup,
 * or splitting it out. This splits it out (`GET /orders/{orderId}` for
 * current status/fulfillment, `GET /orders/{orderId}/history` for the
 * full transition log) for the same reason Story 4.2 already gave a
 * dedicated sub-route to proof-of-payment status: the two answer different
 * questions ("what's happening with my order right now" vs. "show me the
 * full audit trail"), a buyer-facing UI is far more likely to want just
 * the first on every page load, and nothing here prevents a future caller
 * from hitting both in parallel when it needs the full picture.
 *
 * **Admin auth gap (Stories 7.1/7.2, not yet implemented)**: this story's
 * AC also says the history should be queryable "by the buyer via their
 * token, or by an authenticated Admin" — but JWT Admin auth does not exist
 * anywhere in this codebase yet as of Sprint 3 (7.1/7.2 come later in this
 * same sprint). Implementing a real admin path here would mean inventing
 * an auth mechanism out of order, so this story deliberately implements
 * ONLY the buyer-token path, which is what's actually verifiable today.
 * When 7.1/7.2 land, the natural shape is a second guard (an
 * `AdminAuthGuard` analogous to this one) on a sibling admin route reusing
 * `OrderLookupService.getDetail`/`getHistory` completely unchanged — that
 * service already takes a plain `orderId` with no buyer-specific
 * assumption baked in (see its own doc comment). Not solved here, same
 * pattern as the Story 4.1 FX-rate-admin-edit gap and the Story 6.1
 * SMTP-provider gap already flagged elsewhere in this codebase.
 */
@ApiTags('orders')
@Controller('orders/:orderId')
export class OrderLookupController {
  constructor(private readonly orderLookup: OrderLookupService) {}

  @Get()
  @UseGuards(OrderAccessTokenGuard)
  @ApiBearerAuth()
  @ApiParam({
    name: 'orderId',
    description: 'The Order to look up (from the checkout response).',
  })
  @ApiOperation({
    summary: "Get an Order's current status and fulfillment details",
    description:
      "Gated by the one-time orderAccessToken issued at checkout (send as \"Authorization: Bearer <token>\", never the cart cookie) — the exact same mechanism Story 4.2's proof-of-payment routes use. Covers FR-13's retrievability requirement: a buyer who kept their token can look up what they ordered, its current AD-7 status, its totals, and its fulfillment/delivery details, without needing an account. Admin access to this same data is a Story 7.1/7.2 follow-up (see this controller's own doc comment) — not implemented by this route.",
  })
  @ApiResponse({ status: 200, type: OrderDetailResponseDto })
  @ApiResponse({
    status: 401,
    description:
      "errorCode MISSING_ORDER_ACCESS_TOKEN (no Authorization header) or INVALID_ORDER_ACCESS_TOKEN (wrong token, a token valid for a different Order, or a syntactically-invalid/nonexistent orderId — deliberately collapsed into the same response so this endpoint can never be used to enumerate which Order ids exist; see OrderAccessTokenGuard's own doc comment).",
  })
  async getDetail(
    @Req() request: RequestWithOrder,
  ): Promise<OrderDetailResponseDto> {
    return this.orderLookup.getDetail(request.order.id);
  }

  @Get('history')
  @UseGuards(OrderAccessTokenGuard)
  @ApiBearerAuth()
  @ApiParam({
    name: 'orderId',
    description: 'The Order whose status-transition history to retrieve.',
  })
  @ApiOperation({
    summary: "Get an Order's full status-transition history",
    description:
      'Every OrderStatusHistory row for this Order, oldest first, each with its own timestamp and actorType (system/paypal_webhook/admin/cron) — not just the current status (FR-17, AD-7). An Order that has never left its initial state still returns its single creation-transition row here, never an empty array (Story 5.1 AC3). Same orderAccessToken gate as the route above.',
  })
  @ApiResponse({ status: 200, type: [OrderStatusHistoryEntryDto] })
  @ApiResponse({
    status: 401,
    description:
      'errorCode MISSING_ORDER_ACCESS_TOKEN or INVALID_ORDER_ACCESS_TOKEN — same as the route above.',
  })
  async getHistory(
    @Req() request: RequestWithOrder,
  ): Promise<OrderStatusHistoryEntryDto[]> {
    return this.orderLookup.getHistory(request.order.id);
  }
}
