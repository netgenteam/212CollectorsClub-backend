import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CustomerAuthGuard,
  type RequestWithCustomer,
} from '../common/customer-auth.guard.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { CustomerAddressesService } from './customer-addresses.service.js';
import { UpdateCustomerAddressDto } from './dto/update-customer-address.dto.js';
import { CreateCustomerAddressDto } from './dto/create-customer-address.dto.js';
import {
  CustomerAddressListResponseDto,
  CustomerAddressResponseDto,
} from './dto/customer-address-response.dto.js';

/** Story 17.2 (FR-84/85, AD-72): the authenticated customer's address book. */
@ApiTags('customer-addresses')
@Controller('auth/addresses')
@UseGuards(CustomerAuthGuard)
@ApiCookieAuth('customer-session')
export class CustomerAddressesController {
  constructor(private readonly addresses: CustomerAddressesService) {}

  @Get()
  @ApiOperation({
    summary: 'List my addresses',
    description: 'Default address first, then newest first.',
  })
  @ApiResponse({ status: 200, type: CustomerAddressListResponseDto })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  async list(
    @Req() req: RequestWithCustomer,
  ): Promise<CustomerAddressListResponseDto> {
    return {
      data: await this.addresses.list((req.customer as { id: string }).id),
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an address',
    description:
      'The first address becomes the default. Max 10 per customer. ID document and phone are stored normalized.',
  })
  @ApiResponse({ status: 201, type: CustomerAddressResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid body or errorCode SHIPPING_INVALID (details.errors).',
  })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({
    status: 422,
    description:
      'errorCode ADDRESS_LIMIT_REACHED, SHIPPING_AGENCY_UNAVAILABLE or DELIVERY_MODE_NOT_ALLOWED.',
  })
  @ApiResponse({
    status: 409,
    description: 'errorCode ADDRESS_DEFAULT_CONFLICT.',
  })
  create(
    @Req() req: RequestWithCustomer,
    @Body(strictBody(CreateCustomerAddressDto))
    dto: Readonly<CreateCustomerAddressDto>,
  ): Promise<CustomerAddressResponseDto> {
    return this.addresses.create((req.customer as { id: string }).id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an address',
    description:
      'Partial update; the merged result is re-validated. isDefault is not accepted (use set-default). Agency activity is only required when agencyId is sent.',
  })
  @ApiResponse({ status: 200, type: CustomerAddressResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid/empty body or errorCode SHIPPING_INVALID (details.errors).',
  })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({ status: 404, description: 'errorCode ADDRESS_NOT_FOUND.' })
  @ApiResponse({
    status: 422,
    description:
      'errorCode SHIPPING_AGENCY_UNAVAILABLE or DELIVERY_MODE_NOT_ALLOWED.',
  })
  @ApiResponse({
    status: 409,
    description: 'errorCode ADDRESS_DEFAULT_CONFLICT.',
  })
  update(
    @Req() req: RequestWithCustomer,
    @Param('id') id: string,
    @Body(strictBody(UpdateCustomerAddressDto))
    dto: Readonly<UpdateCustomerAddressDto>,
  ): Promise<CustomerAddressResponseDto> {
    return this.addresses.update((req.customer as { id: string }).id, id, dto);
  }

  @Patch(':id/set-default')
  @ApiOperation({
    summary: 'Make an address the default',
    description: 'Idempotent: 200 with no changes if it already is.',
  })
  @ApiResponse({ status: 200, type: CustomerAddressResponseDto })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({ status: 404, description: 'errorCode ADDRESS_NOT_FOUND.' })
  @ApiResponse({
    status: 409,
    description: 'errorCode ADDRESS_DEFAULT_CONFLICT.',
  })
  setDefault(
    @Req() req: RequestWithCustomer,
    @Param('id') id: string,
  ): Promise<CustomerAddressResponseDto> {
    return this.addresses.setDefault((req.customer as { id: string }).id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an address',
    description:
      'If it was the default, the most recent remaining address becomes default. Existing orders are unaffected.',
  })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({ status: 404, description: 'errorCode ADDRESS_NOT_FOUND.' })
  @ApiResponse({
    status: 409,
    description: 'errorCode ADDRESS_DEFAULT_CONFLICT.',
  })
  async remove(
    @Req() req: RequestWithCustomer,
    @Param('id') id: string,
  ): Promise<void> {
    await this.addresses.remove((req.customer as { id: string }).id, id);
  }
}
