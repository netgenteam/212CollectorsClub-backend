import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import {
  requireObjectBody,
  strictBody,
} from '../customer-auth/strict-body.pipe.js';
import {
  AuditEventDetailDto,
  AuditEventsPageDto,
  AuditHeadDto,
  AuditVerificationsDto,
  VerifyAuditDto,
  VerifyResponseDto,
} from './audit-admin.dto.js';
import {
  AUDIT_PAGE_SIZE,
  AuditReadService,
  parseAuditEventsQuery,
} from './audit-read.service.js';
import { AuditVerifyService } from './audit-verify.service.js';

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;

/**
 * Story 20.1 (FR-140, FR-137): admin API of the immutable audit log. READ-ONLY
 * except `POST verify` (which only appends an `AUDIT_VERIFIED` event and an
 * operational `Audit_Verifications` row). There is no route that changes or
 * deletes an event (a test asserts it).
 */
@ApiTags('admin-audit')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/audit')
export class AuditAdminController {
  constructor(
    private readonly reader: AuditReadService,
    private readonly verifier: AuditVerifyService,
  ) {}

  @Get('events')
  @ApiOperation({
    summary: 'Audit events, newest first (cursor by seq, 50 per page)',
    description:
      'Filters combine with AND. `to` as a date (YYYY-MM-DD) covers that whole day (UTC).',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO 8601 date or date-time (inclusive)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO 8601 date or date-time',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'e.g. ORDER_STATUS_CHANGED',
  })
  @ApiQuery({ name: 'actorId', required: false, description: 'uuid' })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'requestId', required: false, description: 'uuid' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'nextCursor of the previous page',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuditEventsPageDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'AUDIT_FILTER_INVALID',
  })
  @ApiResponse(UNAUTH)
  events(@Query() query: Record<string, unknown>): Promise<AuditEventsPageDto> {
    void AUDIT_PAGE_SIZE;
    return this.reader.list(parseAuditEventsQuery(query));
  }

  @Get('events/:seq')
  @ApiOperation({
    summary: 'One event with its hashes and a link to the entity',
  })
  @ApiParam({ name: 'seq', description: 'Sequence number (>= 1)' })
  @ApiResponse({ status: HttpStatus.OK, type: AuditEventDetailDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'AUDIT_FILTER_INVALID (seq is not a positive integer)',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'AUDIT_EVENT_NOT_FOUND',
  })
  @ApiResponse(UNAUTH)
  async event(@Param('seq') seq: string): Promise<AuditEventDetailDto> {
    if (!/^[1-9]\d{0,15}$/.test(seq)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'AUDIT_FILTER_INVALID',
        'seq must be a positive integer.',
      );
    }
    const ev = await this.reader.bySeq(Number(seq));
    if (!ev) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'AUDIT_EVENT_NOT_FOUND',
        'There is no audit event with that seq.',
      );
    }
    return ev;
  }

  @Get('head')
  @ApiOperation({
    summary: 'Head of the chain: last seq/hash and row count',
    description:
      'Write the hash down outside the database periodically (external anchor): a DBA with full privileges could rewrite the whole chain.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuditHeadDto })
  @ApiResponse(UNAUTH)
  head(): Promise<AuditHeadDto> {
    return this.reader.head();
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the hash chain (resumable)',
    description:
      'Recomputes every hash, prevHash, seq continuity and the genesis. At most 200.000 rows per call; when `done` is false call again with `fromSeq = nextFromSeq`. Writes an AUDIT_VERIFIED event and an Audit_Verifications row. The work is sliced so it does not block the server.',
  })
  @ApiBody({ type: VerifyAuditDto, required: false })
  @ApiResponse({ status: HttpStatus.OK, type: VerifyResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'validation error | AUDIT_FROM_SEQ_OUT_OF_RANGE',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'AUDIT_VERIFY_IN_PROGRESS',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'AUDIT_UNAVAILABLE (the audit log could not be written) | AUDIT_VERIFY_TIMEOUT',
  })
  @ApiResponse(UNAUTH)
  async verify(
    @Req() req: RequestWithAdminUser,
    // Typed `object` on purpose: the global whitelist pipe would otherwise strip unknown
    // properties before `strictBody` could reject them (400).
    @Body(requireObjectBody, strictBody(VerifyAuditDto)) body: object,
  ): Promise<VerifyResponseDto> {
    const dto = body as VerifyAuditDto;
    if (dto.fromSeq !== undefined) {
      const head = await this.reader.head();
      if (dto.fromSeq > head.seq + 1) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'AUDIT_FROM_SEQ_OUT_OF_RANGE',
          `fromSeq is beyond the end of the chain (head is ${head.seq}).`,
        );
      }
    }
    return this.verifier.run({
      mode: dto.mode,
      fromSeq: dto.fromSeq,
      limit: dto.limit,
      source: 'MANUAL',
      actor: { actorType: 'ADMIN', actorId: req.user.id },
    });
  }

  @Get('verifications')
  @ApiOperation({
    summary:
      'History of verifications (newest first) and the broken-chain flag',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuditVerificationsDto })
  @ApiResponse(UNAUTH)
  verifications(): Promise<AuditVerificationsDto> {
    return this.reader.verifications();
  }
}
