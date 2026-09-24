import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto.js';
import { PaginatedAdminOrdersResponseDto } from './dto/paginated-admin-orders-response.dto.js';

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
 */
@ApiTags('orders')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly adminOrdersService: AdminOrdersService) {}

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
}
