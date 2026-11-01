import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { AdminFxService } from './admin-fx.service.js';
import {
  FX_AUDIT_DEFAULT_LIMIT,
  FX_AUDIT_MAX_LIMIT,
  FX_HISTORY_DEFAULT_LIMIT,
  FX_HISTORY_MAX_LIMIT,
  FxAuditQueryDto,
  FxAuditResponseDto,
  FxHistoryQueryDto,
  FxHistoryResponseDto,
  FxSettingsResponseDto,
  FxStatusResponseDto,
  RefreshFxResponseDto,
  UpdateFxSettingsDto,
  UpdateFxSettingsResponseDto,
} from './dto/admin-fx.dto.js';

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;

/** Story 18.2 (AD-79 "Admin", FR-90/92/95): admin control panel of the VES rate. */
@ApiTags('admin-fx')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/fx')
export class AdminFxController {
  constructor(private readonly fx: AdminFxService) {}

  @Get('settings')
  @ApiOperation({ summary: 'FX source, thresholds and current rate' })
  @ApiResponse({ status: HttpStatus.OK, type: FxSettingsResponseDto })
  @ApiResponse(UNAUTH)
  settings(): Promise<FxSettingsResponseDto> {
    return this.fx.getSettings();
  }

  @Put('settings')
  @ApiOperation({
    summary: 'Change the rate source / thresholds',
    description:
      'Saves + audits in one transaction, then refreshes immediately (outside the tx). If that refresh fails the response is still 200 with stale=true and the previous rate is kept.',
  })
  @ApiBody({ type: UpdateFxSettingsDto })
  @ApiResponse({ status: HttpStatus.OK, type: UpdateFxSettingsResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'FX_MANUAL_RATE_REQUIRED | validation errors',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'FX_RATE_UNAVAILABLE (setting row missing)',
  })
  updateSettings(
    @Body(strictBody(UpdateFxSettingsDto))
    dto: Readonly<UpdateFxSettingsDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<UpdateFxSettingsResponseDto> {
    return this.fx.updateSettings(dto, req.user.id);
  }

  @Get('status')
  @ApiOperation({
    summary:
      'Rate status + live value of each source (last snapshot, no network)',
  })
  @ApiResponse({ status: HttpStatus.OK, type: FxStatusResponseDto })
  @ApiResponse(UNAUTH)
  status(): Promise<FxStatusResponseDto> {
    return this.fx.getStatus();
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh the active source now and return the status',
  })
  @ApiResponse({ status: HttpStatus.OK, type: RefreshFxResponseDto })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'FX_REFRESH_IN_PROGRESS',
  })
  refresh(): Promise<RefreshFxResponseDto> {
    return this.fx.refresh();
  }

  @Post('accept-rejected')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the last rejected reading of the active source',
    description:
      'Skips the variation/date comparison only; audits the action. Concurrent calls: one applies, the others get 409.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: FxStatusResponseDto })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'FX_NO_REJECTED_READING',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'FX_REJECTED_READING_NOT_ACCEPTABLE',
  })
  acceptRejected(
    @Req() req: RequestWithAdminUser,
  ): Promise<FxStatusResponseDto> {
    return this.fx.acceptRejected(req.user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'Valid rate snapshots, newest fetch first' })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['BCV_USD', 'BCV_EUR', 'PARALELO_USD', 'MANUAL'],
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `1..${FX_HISTORY_MAX_LIMIT}, default ${FX_HISTORY_DEFAULT_LIMIT}`,
  })
  @ApiResponse({ status: HttpStatus.OK, type: FxHistoryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'invalid source / limit',
  })
  @ApiResponse(UNAUTH)
  history(@Query() q: FxHistoryQueryDto): Promise<FxHistoryResponseDto> {
    return this.fx.history(q);
  }

  @Get('audit')
  @ApiOperation({
    summary: 'Source-change audit, newest first (id + email of the admin only)',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `1..${FX_AUDIT_MAX_LIMIT}, default ${FX_AUDIT_DEFAULT_LIMIT}`,
  })
  @ApiResponse({ status: HttpStatus.OK, type: FxAuditResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'invalid page / limit',
  })
  @ApiResponse(UNAUTH)
  audit(@Query() q: FxAuditQueryDto): Promise<FxAuditResponseDto> {
    return this.fx.audit(q);
  }
}
