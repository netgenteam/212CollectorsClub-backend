import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CustomerAuthGuard,
  type RequestWithCustomer,
} from '../common/customer-auth.guard.js';
import { ListCustomerOrdersQueryDto } from './dto/list-customer-orders-query.dto.js';
import { CustomerOrderDetailResponseDto } from './dto/order-lookup-response.dto.js';
import { PaginatedCustomerOrdersResponseDto } from './dto/paginated-customer-orders-response.dto.js';
import { OrderLookupService } from './order-lookup.service.js';

/**
 * Story 12.6 (FR-45, AD-31): "mis pedidos". Customer session only (an admin
 * Bearer or an orderAccessToken never authenticates here).
 */
@ApiTags('customer-auth')
@Controller('auth/orders')
@UseGuards(CustomerAuthGuard)
@ApiCookieAuth('customer-session')
export class CustomerOrdersController {
  constructor(private readonly orderLookup: OrderLookupService) {}

  @Get()
  @ApiOperation({
    summary: "List the authenticated customer's orders",
    description:
      'Paginated like the catalog (`page`, `limit`; `{data, meta}`), newest first, only orders linked to the caller.',
  })
  @ApiResponse({ status: 200, type: PaginatedCustomerOrdersResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid page/limit.' })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  list(
    @Req() req: RequestWithCustomer,
    @Query() query: ListCustomerOrdersQueryDto,
  ): Promise<PaginatedCustomerOrdersResponseDto> {
    return this.orderLookup.listForCustomer(
      (req.customer as { id: string }).id,
      query.page,
      query.limit,
    );
  }

  @Get(':orderId')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: "Get one of the authenticated customer's orders",
    description:
      'Same detail shape as the token lookup plus `statusHistory` (oldest first). An order of another customer, a guest order and an unknown id give the SAME 404.',
  })
  @ApiResponse({ status: 200, type: CustomerOrderDetailResponseDto })
  @ApiResponse({ status: 400, description: 'orderId is not a UUID.' })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({ status: 404, description: 'errorCode ORDER_NOT_FOUND.' })
  detail(
    @Req() req: RequestWithCustomer,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<CustomerOrderDetailResponseDto> {
    return this.orderLookup.getDetailForCustomer(
      (req.customer as { id: string }).id,
      orderId,
    );
  }
}
