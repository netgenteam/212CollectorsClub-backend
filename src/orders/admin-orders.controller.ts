import { createReadStream } from 'node:fs';
import {
  Controller,
  Get,
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
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { AdminOrderPaymentService } from './admin-order-payment.service.js';
import { AdminOrderFulfillmentService } from './admin-order-fulfillment.service.js';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto.js';
import { PaginatedAdminOrdersResponseDto } from './dto/paginated-admin-orders-response.dto.js';
import { AdminPaymentDecisionResponseDto } from './dto/admin-payment-decision-response.dto.js';
import { AdminFulfillmentDecisionResponseDto } from './dto/admin-fulfillment-decision-response.dto.js';

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
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List/filter every Order (admin)',
    description:
      'Paginated list of every Order, sorted by createdAt (most recent first by default, or sortOrder=asc to reverse). Combinable (AND) `status`/`paymentRail` filters support the daily reconciliation workflow (PRD UJ-5), e.g. status=pending_verification to find Pago Móvil Orders awaiting verification. Never errors on no matches — returns an empty paginated page with 200, same criterion as the public GET /api/v1/products (Story 2.2).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated Orders matching the given filters.',
    type: PaginatedAdminOrdersResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'A malformed query param, e.g. an out-of-enum status/paymentRail, or page/limit outside their valid range.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  listOrders(
    @Query() query: ListAdminOrdersQueryDto,
  ): Promise<PaginatedAdminOrdersResponseDto> {
    return this.adminOrdersService.listOrders(query);
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
}
