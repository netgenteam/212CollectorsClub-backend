import { createReadStream } from 'node:fs';
import {
  Controller,
  Body,
  Get,
  Patch,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiException } from '../common/api-exception.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { assertNoIdDocInQuery } from '../common/id-doc-not-in-url.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import {
  IdDocRateLimitedError,
  IdDocRevealService,
} from '../crypto/id-doc-reveal.service.js';
import { AdminOrdersService } from './admin-orders.service.js';
import {
  RevealIdDocDto,
  RevealIdDocResponseDto,
} from './dto/reveal-id-doc.dto.js';
import { OrderLookupService } from './order-lookup.service.js';
import { AdminOrderDetailResponseDto } from './dto/admin-order-detail-response.dto.js';
import { AdminOrderPaymentService } from './admin-order-payment.service.js';
import { AdminOrderFulfillmentService } from './admin-order-fulfillment.service.js';
import { AdminOrderTrackingService } from './admin-order-tracking.service.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import {
  AdminOrderTrackingResponseDto,
  UpdateOrderTrackingDto,
} from './dto/admin-order-tracking.dto.js';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto.js';
import { SearchAdminOrdersDto } from './dto/search-admin-orders.dto.js';
import { PaginatedAdminOrdersResponseDto } from './dto/paginated-admin-orders-response.dto.js';
import { AdminPaymentDecisionResponseDto } from './dto/admin-payment-decision-response.dto.js';
import { AdminFulfillmentDecisionResponseDto } from './dto/admin-fulfillment-decision-response.dto.js';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto.js';
import { AdminReconciliationResponseDto } from './dto/admin-reconciliation-response.dto.js';

/**
 * Story 9.1 (FR-26, NFR-4; AD-11, AD-14). The first §4.9 "Admin Order &
 * Payment Management" route — gated by the exact same `AdminAuthGuard`
 * Epic 8 already established, on a route nested under `admin/orders`
 * inside THIS SAME `OrdersModule` (not a new `AdminOrders` module — AD-14
 * says so explicitly for this one module, unlike Epic 8's `admin-catalog/`
 * sibling-module split; `OrderLookupController`'s own doc comment
 * anticipated exactly this route landing here). `OrdersModule` did not
 * previously need `PassportModule.register({ defaultStrategy: 'admin-jwt'
 * })` (its two existing controllers use `OrderAccessTokenGuard`, an
 * unrelated hand-rolled guard) — this route is the first thing in this
 * module to use `AdminAuthGuard`, so `orders.module.ts` now imports it too,
 * same one-line fix `admin-catalog.module.ts` already documents in full.
 *
 * **Story 9.2 additions** (FR-16, FR-25, NFR-5, NFR-6; AD-7, AD-12, AD-13,
 * AD-16): three more routes nested under `admin/orders/:orderId`, all
 * delegating to the new `AdminOrderPaymentService` (kept separate from the
 * read-only `AdminOrdersService` above — same read/write service split
 * `ProofOfPaymentService`/`OrderLookupService` already model elsewhere in
 * this same module). `orderId` is validated with `ParseUUIDPipe` on every
 * one of these three routes (a malformed id gets a plain 400 before ever
 * reaching the service/Prisma) — unlike the buyer-facing
 * `OrderAccessTokenGuard` routes elsewhere in this module, which
 * deliberately collapse a bad orderId into the same 401 as a wrong token
 * to avoid enumeration; that concern does not apply here, since every
 * caller of THESE routes is already a fully-authenticated Admin who can
 * see the full Order list anyway (Story 9.1).
 *
 * **Story 9.3 additions** (FR-27, NFR-4, NFR-6; AD-7, AD-16): two more
 * routes nested under `admin/orders/:orderId`, delegating to the new
 * `AdminOrderFulfillmentService` (kept separate from `AdminOrderPaymentService`
 * — same one-concern-per-service split this controller already follows for
 * 9.1/9.2). Same `ParseUUIDPipe` treatment as the 9.2 routes: a malformed
 * `orderId` is a plain 400 before ever reaching the service/Prisma.
 *
 * **Story 9.4 addition** (FR-28, NFR-4; AD-11, AD-14): one more route,
 * `GET admin/orders/reconciliation`, delegating back to the read-only
 * `AdminOrdersService` (Story 9.1) — same service, a second method, not a
 * new one (this is a query, not a mutation, so it belongs with `listOrders`
 * rather than the payment/fulfillment services). Declared BEFORE the
 * `:orderId/...` routes below so the static segment `reconciliation` is
 * never a candidate to be captured as a `:orderId` param (Nest matches
 * routes in declaration order); today there's no bare `:orderId` route to
 * collide with, but keeping the static route first is the defensive
 * convention regardless. See `AdminOrdersService.getReconciliation`'s own
 * doc comment for why the story's "the one sanctioned $queryRaw exception"
 * framing is stale, and what this endpoint actually aggregates and why.
 */
@ApiTags('orders')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly adminOrdersService: AdminOrdersService,
    private readonly adminOrderPaymentService: AdminOrderPaymentService,
    private readonly adminOrderFulfillmentService: AdminOrderFulfillmentService,
    private readonly orderLookup: OrderLookupService,
    private readonly adminOrderTrackingService: AdminOrderTrackingService,
    private readonly idDocReveal: IdDocRevealService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List/filter every Order (admin)',
    description:
      'Paginated list of every Order, sorted by createdAt (most recent first by default, or sortOrder=asc to reverse). Combinable (AND) `status`/`paymentRail`/`refundPending` filters (refundPending=true: Stripe payments needing a manual refund, Story 14.5b) support the daily reconciliation workflow (PRD UJ-5), e.g. status=pending_verification to find Pago Móvil Orders awaiting verification. Never errors on no matches — returns an empty paginated page with 200, same criterion as the public GET /api/v1/products (Story 2.2).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated Orders matching the given filters.',
    type: PaginatedAdminOrdersResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'A malformed query param, e.g. an out-of-enum status/paymentRail, or page/limit outside their valid range; or errorCode ID_DOC_IN_URL_NOT_ALLOWED if the URL carries an ID document (`idDoc`, `idDoc[]`...): use POST /admin/orders/search. The value is not echoed and nothing is queried.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  listOrders(
    @Query() query: ListAdminOrdersQueryDto,
    @Req() request: Request,
  ): Promise<PaginatedAdminOrdersResponseDto> {
    // Story 20.4 (FR-124): a cedula never travels in a URL. Looked at on the raw query (the DTO
    // strips unknown keys, which used to turn `?idDoc[]=` into an unfiltered list).
    assertNoIdDocInQuery(request.query, 'POST /admin/orders/search');
    return this.adminOrdersService.listOrders(query);
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: SearchAdminOrdersDto })
  @ApiOperation({
    summary: 'Search Orders by exact ID document (admin)',
    description:
      'Story 20.4 (FR-124/126). Same list as GET /admin/orders (same pagination, sort and `status`/`paymentRail`/`refundPending` filters, same response) restricted to the Orders whose RECIPIENT or BUYER ID document equals `idDoc`, by blind index. The cedula goes in the BODY because a URL is written to proxy and web-server error logs. Equality only: no partial match, no LIKE. Never errors on no matches (empty page, 200). The value is never logged nor echoed. `GET /admin/orders?idDoc=` (also `idDoc[]=`) is 400 ID_DOC_IN_URL_NOT_ALLOWED.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated Orders matching the ID document and the filters.',
    type: PaginatedAdminOrdersResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode ID_DOC_FILTER_INVALID (`details = {field: "idDoc", reason: "INVALID_FORMAT"}`: not a complete valid ID document), or a malformed body field (unknown property, page/limit out of range, bad enum).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  searchOrders(
    @Body(strictBody(SearchAdminOrdersDto))
    dto: Readonly<SearchAdminOrdersDto>,
    @Res({ passthrough: true }) res: Response,
    @Req() request: Request,
  ): Promise<PaginatedAdminOrdersResponseDto> {
    // Story 20.6: `POST /admin/orders/search?idDoc=...` is as bad as the GET: the URL is logged.
    assertNoIdDocInQuery(request.query, 'POST /admin/orders/search');
    // Orders of a person found by cedula: never cached by a proxy or the browser.
    res.setHeader('Cache-Control', 'no-store');
    const { idDoc, ...filters } = dto;
    return this.adminOrdersService.listOrders(filters, idDoc);
  }

  @Get('reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consolidated payment reconciliation summary (admin)',
    description:
      "Cross-rail (Stripe + Pago Móvil) payment summary for the given period, grouped by (paymentRail, status) with per-rail subtotals and a grand total — see AdminOrdersService.getReconciliation's own doc comment for the full field-choice rationale (PRD UJ-5). A period with no matching Orders returns this same shape with empty arrays and a zeroed grandTotal, never an error.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The reconciliation summary for the given period.',
    type: AdminReconciliationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'from/to are not valid ISO-8601 dates, or `to` is before `from`.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  getReconciliation(
    @Query() query: ReconciliationQueryDto,
  ): Promise<AdminReconciliationResponseDto> {
    return this.adminOrdersService.getReconciliation(query);
  }

  @Get(':orderId')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Order detail with refund-pending flag (admin)',
    description:
      'Full Order detail (same shape as GET /orders/{orderId}) plus `refundPending` (Story 14.5b, AD-50): true when Stripe confirmed a payment that could not be applied (no stock / already payment_failed) and a manual refund from the Stripe dashboard is required.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminOrderDetailResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  async getOrderDetail(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<AdminOrderDetailResponseDto> {
    const exists = await this.adminOrdersService.orderExists(orderId);
    if (!exists) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'ORDER_NOT_FOUND',
        'Order not found.',
      );
    }
    const [detail, refundPending] = await Promise.all([
      this.orderLookup.getDetail(orderId),
      this.adminOrdersService.hasRefundPending(orderId),
    ]);
    return { ...detail, refundPending };
  }

  @Get(':orderId/proof-of-payment')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: "Download an Order's most recent Proof-of-Payment file",
    description:
      "Streams the raw file the buyer uploaded (Story 4.2) for this Order's most recent ProofOfPayment row — reachable EXCLUSIVELY through this AdminAuthGuard-gated route, never through a static-mounted public path (AD-12, NFR-5; there isn't one — see upload-paths.constants.ts). Always sent with Content-Disposition: attachment (forced download, never inline render), regardless of the stored MIME type — closing the gap Story 4.2's QA flagged: the upload's fileFilter only trusts the client-declared Content-Type, not real magic bytes, so an application/pdf upload could in principle carry embedded JS; forcing a download means an Admin's browser never executes/renders it inline.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'The raw file bytes, Content-Type set to the stored mimeType, Content-Disposition: attachment.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'errorCode ORDER_NOT_FOUND (no such Order), PROOF_OF_PAYMENT_NOT_FOUND (Order exists but nothing has been uploaded yet), or PROOF_OF_PAYMENT_FILE_MISSING (a DB row exists but its file is missing on disk — should never happen in normal operation).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  async getProofOfPayment(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file =
      await this.adminOrderPaymentService.getProofOfPaymentFile(orderId);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.downloadFileName}"`,
      'Content-Length': String(file.sizeBytes),
    });
    return new StreamableFile(createReadStream(file.absolutePath));
  }

  @Post(':orderId/confirm-payment')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Confirm a Pago Móvil payment (pending_verification -> paid)',
    description:
      'Inside one DB transaction (AD-16): guarded pending_verification->paid transition (actorType=admin, adminUserId from the JWT), then AD-13\'s exact guarded decrement for every active StockHold on this Order — `UPDATE "Products" SET stock = stock - qty, "heldQty" = "heldQty" - qty WHERE stock >= qty AND "heldQty" >= qty` — each hold marked releasedAt in the same transaction. Zero rows affected on EITHER the transition or ANY line\'s decrement rolls back everything (never a partial decrement, never stock touched on a stale Order).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The Order is now paid; stock/heldQty already reflect it.',
    type: AdminPaymentDecisionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ORDER_NOT_PENDING_VERIFICATION (this Order was already confirmed/rejected/expired — includes the current status in `details`; a duplicate/double-click confirm is ALWAYS an explicit conflict here, never a silent no-op) or INSUFFICIENT_STOCK (stock/held quantity ran out between checkout and this confirmation — the Order was NOT confirmed and remains pending_verification).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  confirmPayment(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() request: RequestWithAdminUser,
  ): Promise<AdminPaymentDecisionResponseDto> {
    return this.adminOrderPaymentService.confirmPayment(orderId, request.user);
  }

  @Post(':orderId/reject-payment')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary:
      'Reject a Pago Móvil payment (pending_verification -> payment_rejected, terminal)',
    description:
      'Inside one DB transaction (AD-16): guarded pending_verification->payment_rejected transition (actorType=admin, adminUserId from the JWT — AD-7: payment_rejected is TERMINAL, no path back to pending), then releases every active StockHold on this Order via `UPDATE "Products" SET "heldQty" = "heldQty" - qty WHERE "heldQty" >= qty` — stock itself is never touched (nothing was ever actually sold), so the Product simply becomes available again.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'The Order is now payment_rejected; every StockHold on it is released.',
    type: AdminPaymentDecisionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ORDER_NOT_PENDING_VERIFICATION (this Order was already confirmed/rejected/expired — includes the current status in `details`; a duplicate/double-click reject is ALWAYS an explicit conflict here, never a silent no-op) or STOCK_HOLD_RELEASE_CONFLICT (should never happen in normal operation — see AdminOrderPaymentService).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  rejectPayment(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() request: RequestWithAdminUser,
  ): Promise<AdminPaymentDecisionResponseDto> {
    return this.adminOrderPaymentService.rejectPayment(orderId, request.user);
  }

  @Post(':orderId/fulfill')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Mark a paid Order as fulfilled (paid -> fulfilled, terminal)',
    description:
      'Guarded `paid->fulfilled` transition (actorType=admin, adminUserId from the JWT — AD-7: fulfilled is TERMINAL). No stock is touched — it was already decremented once, permanently, when the Order was confirmed paid (4.3/9.2).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The Order is now fulfilled.',
    type: AdminFulfillmentDecisionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ORDER_NOT_PAID (this Order is not currently paid — still pending verification, or already fulfilled/cancelled/etc.; includes the current status in `details`. A duplicate/double-click fulfill is ALWAYS an explicit conflict here, never a silent no-op).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  fulfillOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() request: RequestWithAdminUser,
  ): Promise<AdminFulfillmentDecisionResponseDto> {
    return this.adminOrderFulfillmentService.fulfillOrder(
      orderId,
      request.user,
    );
  }

  @Post(':orderId/cancel')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Cancel a paid Order (paid -> cancelled, terminal)',
    description:
      'Inside one DB transaction (AD-16): guarded `paid->cancelled` transition (actorType=admin, adminUserId from the JWT — AD-7: cancelled is TERMINAL), then a compensating stock re-increment for every OrderLine on this Order — `UPDATE "Products" SET stock = stock + qty WHERE id = ?` using each line\'s snapshotted purchased quantity. Zero rows affected on EITHER the transition or ANY line\'s re-increment rolls back everything (never a partial re-increment across a multi-line Order).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The Order is now cancelled; stock already reflects it.',
    type: AdminFulfillmentDecisionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ORDER_NOT_PAID (this Order is not currently paid — includes the current status in `details`; a duplicate/double-click cancel is ALWAYS an explicit conflict here, never a silent no-op) or STOCK_REINCREMENT_CONFLICT (should never happen in normal operation — see AdminOrderFulfillmentService).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  cancelOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() request: RequestWithAdminUser,
  ): Promise<AdminFulfillmentDecisionResponseDto> {
    return this.adminOrderFulfillmentService.cancelOrder(orderId, request.user);
  }

  @Patch(':orderId/tracking')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiBody({ type: UpdateOrderTrackingDto })
  @ApiOperation({
    summary: 'Set or clear the tracking number (admin)',
    description:
      'Story 17.5 (FR-89). Works in any order status; does not change the status nor send email. `trackingNumber` is trimmed and must match ^[A-Za-z0-9._/-]{3,64}$; null or "" clears it. Each effective change records an audit event (admin, previous and new value); repeating the same value is a no-op. `trackingUrl` comes from the agency template, null if number, agency or template is missing.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminOrderTrackingResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'errorCode TRACKING_NUMBER_INVALID, or unknown body field.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode ORDER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  setTracking(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(strictBody(UpdateOrderTrackingDto))
    dto: Readonly<UpdateOrderTrackingDto>,
    @Req() request: RequestWithAdminUser,
  ): Promise<AdminOrderTrackingResponseDto> {
    return this.adminOrderTrackingService.setTracking(
      orderId,
      dto,
      request.user,
    );
  }

  @Post(':orderId/reveal-id-doc')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiBody({ type: RevealIdDocDto })
  @ApiOperation({
    summary: 'Reveal the full recipient/buyer ID document (admin, audited)',
    description:
      "Story 20.4 (FR-125/126, AD-97). Returns the FULL cedula/RIF/passport of the order (`field`: recipient or buyer). Flow: the stored value is decrypted and checked in memory against its blind index; then an audit transaction of its own is COMMITTED first (it counts this admin's `ID_DOC_REVEALED` events of the last hour inside the audit chain lock and, if there are ID_DOC_REVEAL_MAX_PER_HOUR (30) or more, answers 429 with `Retry-After`; otherwise it inserts the event: admin, order, field, request id, IP, never the value); only after that commit the value is returned, with `Cache-Control: no-store`. If the audit cannot be written the value is NOT delivered (503 AUDIT_UNAVAILABLE). `unparsed: true` flags a legacy value with no recognizable type (no blind index to cross-check).",
  })
  @ApiResponse({ status: HttpStatus.OK, type: RevealIdDocResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid orderId or `field` (or an unknown body field).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'errorCode ORDER_NOT_FOUND, or errorCode ID_DOC_NOT_FOUND: the order has no ID document in that field (e.g. a historical order without buyerId).',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'errorCode ID_DOC_REVEAL_RATE_LIMITED: this admin already revealed ID_DOC_REVEAL_MAX_PER_HOUR (30) documents in the last hour; `Retry-After` header (seconds). No event is written and no value is delivered.',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description:
      'errorCode ID_DOC_INTEGRITY_FAILED: the stored value cannot be read back, or does not match the row blind index (e.g. a ciphertext moved from another order). Nothing is delivered; `details.reason` (BLIND_MISMATCH, BLIND_MISSING, DECRYPT_FAILED, ENC_MALFORMED) says why. The attempt is logged and audited as `ID_DOC_INTEGRITY_FAILED` (admin, order, field, reason; never the value; it uses no slot of the hourly limit). If that event cannot be written the answer is 503 AUDIT_UNAVAILABLE instead.',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'errorCode AUDIT_UNAVAILABLE: the audit event (the reveal, or the integrity-failure one) could not be committed (database error or chain lock wait expired). The value is NOT delivered; retry in a few seconds.',
  })
  async revealIdDoc(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(strictBody(RevealIdDocDto)) dto: Readonly<RevealIdDocDto>,
    @Req() request: RequestWithAdminUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealIdDocResponseDto> {
    // Every answer of this route (value or error) is uncacheable.
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await this.idDocReveal.revealOrderIdDoc(
        orderId,
        dto.field,
        request.user,
      );
    } catch (err) {
      if (err instanceof IdDocRateLimitedError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
      }
      throw err;
    }
  }
}
