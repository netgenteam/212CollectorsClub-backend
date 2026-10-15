import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { AdminCustomersService } from './admin-customers.service.js';
import {
  VerifyCustomerEmailDto,
  VerifyCustomerEmailResponseDto,
} from './dto/verify-customer-email.dto.js';
import { ManualEmailVerifyEnabledGuard } from './manual-email-verify-enabled.guard.js';

/**
 * Story 13.1 (FR-53, AD-39, A24) - TEMPORARY, remove with real SMTP.
 * The flag guard is FIRST: flag off => plain 404 before any auth. Excluded
 * from Swagger so the route is invisible while off (and while on).
 */
@ApiExcludeController()
@UseGuards(ManualEmailVerifyEnabledGuard, AdminAuthGuard)
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly service: AdminCustomersService) {}

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(
    @Req() req: RequestWithAdminUser,
    @Body(strictBody(VerifyCustomerEmailDto))
    dto: Readonly<VerifyCustomerEmailDto>,
  ): Promise<VerifyCustomerEmailResponseDto> {
    return this.service.verifyEmail(req.user.id, dto.email);
  }
}
