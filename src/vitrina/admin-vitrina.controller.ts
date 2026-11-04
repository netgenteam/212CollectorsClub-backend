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
import { ApiException } from '../common/api-exception.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { AdminVitrinaService, toRunSummary } from './admin-vitrina.service.js';
import {
  UpdateVitrinaAlgorithmDto,
  UpdateVitrinaAlgorithmResponseDto,
  VITRINA_AUDIT_DEFAULT_LIMIT,
  VITRINA_AUDIT_MAX_LIMIT,
  VitrinaAlgorithmResponseDto,
  VitrinaAuditQueryDto,
  VitrinaAuditResponseDto,
  VitrinaPreviewQueryDto,
  VitrinaPreviewResponseDto,
  VitrinaRunSummaryDto,
} from './dto/admin-vitrina.dto.js';
import { VitrinaScoringService } from './vitrina-scoring.service.js';

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;

/** Story 18.8 (AD-84, FR-99/100): admin of the Vitrina ranking algorithm. */
@ApiTags('admin-vitrina')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/vitrina')
export class AdminVitrinaController {
  constructor(
    private readonly admin: AdminVitrinaService,
    private readonly scoring: VitrinaScoringService,
  ) {}

  @Get('algorithm')
  @ApiOperation({ summary: 'Current weights/parameters and last run' })
  @ApiResponse({ status: HttpStatus.OK, type: VitrinaAlgorithmResponseDto })
  @ApiResponse(UNAUTH)
  getAlgorithm(): Promise<VitrinaAlgorithmResponseDto> {
    return this.admin.getAlgorithm();
  }

  @Put('algorithm')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @ApiOperation({
    summary: 'Change weights/parameters (audited)',
    description:
      'Locks the settings row (FOR UPDATE) and writes the audit (before/after, adminUserId) in the same transaction. Does NOT recompute unless `recompute: true`; the current ranking stays valid until the next run.',
  })
  @ApiBody({ type: UpdateVitrinaAlgorithmDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: UpdateVitrinaAlgorithmResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'VITRINA_WEIGHTS_INVALID (weights do not add up to 100) | VITRINA_PARAMS_INVALID (windowDays < halfLifeDays) | validation errors (ranges, unknown fields)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'VITRINA_BUSY (the settings row stayed locked behind a long recompute; retry)',
  })
  @ApiResponse(UNAUTH)
  updateAlgorithm(
    @Body(strictBody(UpdateVitrinaAlgorithmDto))
    dto: Readonly<UpdateVitrinaAlgorithmDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<UpdateVitrinaAlgorithmResponseDto> {
    return this.admin.updateAlgorithm(dto, req.user.id);
  }

  @Get('algorithm/audit')
  @ApiOperation({
    summary: 'Algorithm change audit, newest first (before/after + admin)',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `1..${VITRINA_AUDIT_MAX_LIMIT}, default ${VITRINA_AUDIT_DEFAULT_LIMIT}`,
  })
  @ApiResponse({ status: HttpStatus.OK, type: VitrinaAuditResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'invalid page / limit',
  })
  @ApiResponse(UNAUTH)
  audit(@Query() q: VitrinaAuditQueryDto): Promise<VitrinaAuditResponseDto> {
    return this.admin.audit(q);
  }

  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recompute the ranking now',
    description:
      'Atomic: a failure keeps the previous ranking. Shares an advisory lock with the hourly cron.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: VitrinaRunSummaryDto })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'RECOMPUTE_IN_PROGRESS',
  })
  async recompute(): Promise<VitrinaRunSummaryDto> {
    const r = await this.scoring.recompute('ADMIN');
    if (r.status === 'IN_PROGRESS') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'RECOMPUTE_IN_PROGRESS',
        'A Vitrina recompute is already running.',
      );
    }
    return toRunSummary(r);
  }

  @Get('preview')
  @ApiOperation({
    summary: 'Explained preview of the Vitrina over the current run',
    description:
      'Pinned first (MANUAL/MIXED), then the ranking by rank (AUTO/MIXED), no duplicates, only products active and in stock now. Each item carries its score breakdown and reason.',
  })
  @ApiQuery({
    name: 'mode',
    required: false,
    enum: ['MANUAL', 'AUTO', 'MIXED'],
  })
  @ApiQuery({ name: 'size', required: false, type: Number })
  @ApiQuery({ name: 'pinned', required: false, type: String })
  @ApiResponse({ status: HttpStatus.OK, type: VitrinaPreviewResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid mode / size (4..12) / pinned (uuid list, max 12)',
  })
  @ApiResponse(UNAUTH)
  preview(
    @Query() query: VitrinaPreviewQueryDto,
  ): Promise<VitrinaPreviewResponseDto> {
    return this.admin.preview(query);
  }
}
