import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { ShippingAgenciesService } from './shipping-agencies.service.js';
import {
  CreateShippingAgencyDto,
  ShippingAgencyAdminDto,
  ShippingAgencyAdminListResponseDto,
  UpdateShippingAgencyDto,
} from './dto/shipping-agency.dto.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Story 17.1 (AD-71, FR-82): admin agency management (list/create/edit/delete). */
@ApiTags('admin-shipping')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/shipping/agencies')
export class AdminShippingController {
  constructor(private readonly agencies: ShippingAgenciesService) {}

  @Get()
  @ApiOperation({ summary: 'All shipping agencies (admin)' })
  @ApiResponse({
    status: HttpStatus.OK,
    type: ShippingAgencyAdminListResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  async list(): Promise<ShippingAgencyAdminListResponseDto> {
    return { data: await this.agencies.listAdmin() };
  }

  @Post()
  @ApiOperation({
    summary: 'Create a shipping agency',
    description:
      'code is trimmed + upper-cased (^[A-Z0-9_-]{2,50}$), unique and immutable afterwards. Modes and isActive default true.',
  })
  @ApiBody({ type: CreateShippingAgencyDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: ShippingAgencyAdminDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'TRACKING_TEMPLATE_INVALID | validation errors',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SHIPPING_AGENCY_CODE_TAKEN',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'AGENCY_WITHOUT_DELIVERY_MODE',
  })
  create(
    @Body(strictBody(CreateShippingAgencyDto))
    dto: Readonly<CreateShippingAgencyDto>,
  ): Promise<ShippingAgencyAdminDto> {
    return this.agencies.create(dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a shipping agency',
    description:
      'Only when no address or order references it; otherwise deactivate it with PATCH.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'SHIPPING_AGENCY_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SHIPPING_AGENCY_IN_USE',
  })
  remove(@Param('id') id: string): Promise<void> {
    this.assertUuid(id);
    return this.agencies.remove(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a shipping agency',
    description:
      'Partial update (at least one field). trackingUrlTemplate must be https:// with exactly one {trackingNumber}; null clears it.',
  })
  @ApiBody({ type: UpdateShippingAgencyDto })
  @ApiResponse({ status: HttpStatus.OK, type: ShippingAgencyAdminDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'TRACKING_TEMPLATE_INVALID | SHIPPING_AGENCY_EMPTY_UPDATE | validation errors (unknown fields rejected)',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'SHIPPING_AGENCY_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'AGENCY_WITHOUT_DELIVERY_MODE',
  })
  update(
    @Param('id') id: string,
    @Body(strictBody(UpdateShippingAgencyDto))
    dto: Readonly<UpdateShippingAgencyDto>,
  ): Promise<ShippingAgencyAdminDto> {
    this.assertUuid(id);
    return this.agencies.update(id, dto);
  }

  /** A non-uuid id is simply "not found" (never a distinct 400). */
  private assertUuid(id: string): void {
    if (!UUID_RE.test(id)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'SHIPPING_AGENCY_NOT_FOUND',
        'Shipping agency not found.',
      );
    }
  }
}
