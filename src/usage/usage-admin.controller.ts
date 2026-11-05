import {
  Controller,
  Get,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminReadTrailService } from '../audit/admin-read-trail.service.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { UsagePageDto, UsageStatsDto } from './usage-admin.dto.js';
import { UsageLogBuffer } from './usage-log.buffer.js';
import { parseUsageQuery, UsageReadService } from './usage-read.service.js';

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;

/**
 * Story 20.7 (FR-135): READ-ONLY view of the usage log. No route here writes, exports or deletes. The
 * requests to these two routes are NOT recorded (`route-normalize.ts`: the log would feed itself).
 * Rows live 7 days (`PURGE_USAGE_LOG_DAYS`): they contain the IP and user agent of the visitors.
 */
@ApiTags('admin-audit')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/audit/usage')
export class UsageAdminController {
  constructor(
    private readonly reader: UsageReadService,
    private readonly buffer: UsageLogBuffer,
    private readonly trail: AdminReadTrailService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Usage log, newest first (cursor by id, 50 per page)',
    description:
      'Every HTTP request of the last 7 days (health checks, static files and this view excluded). Filters combine with AND. Never a body, a query string, a cookie, an `Authorization` header or a cedula. The URL must not carry an ID document (400 ID_DOC_IN_URL_NOT_ALLOWED). A query cut by its 5 s limit, or one that waits too long for its turn (at most 3 run at once), is 503 USAGE_QUERY_TIMEOUT. The first query of an admin in 15 minutes leaves a USAGE_LOG_QUERIED event in the audit log (no filter, no data); if that event cannot be written the answer is 503 AUDIT_UNAVAILABLE.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO 8601 date or date-time with offset, inclusive',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO 8601; a date covers that whole UTC day',
  })
  @ApiQuery({
    name: 'actorType',
    required: false,
    enum: ['ADMIN', 'CUSTOMER', 'ANON'],
  })
  @ApiQuery({ name: 'actorId', required: false, description: 'uuid' })
  @ApiQuery({
    name: 'route',
    required: false,
    description: 'prefix of a route template, e.g. /api/v1/orders',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'exact HTTP status',
  })
  @ApiQuery({
    name: 'statusClass',
    required: false,
    enum: ['2xx', '3xx', '4xx', '5xx'],
  })
  @ApiQuery({
    name: 'ip',
    required: false,
    description: 'address or CIDR range',
  })
  @ApiQuery({
    name: 'requestId',
    required: false,
    description: 'uuid (the X-Request-Id of a response)',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'nextCursor of the previous page',
  })
  @ApiResponse({ status: HttpStatus.OK, type: UsagePageDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'USAGE_FILTER_INVALID | ID_DOC_IN_URL_NOT_ALLOWED',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'USAGE_QUERY_TIMEOUT | AUDIT_UNAVAILABLE',
  })
  async list(
    @Req() req: RequestWithAdminUser,
    @Query() query: Record<string, unknown>,
  ): Promise<UsagePageDto> {
    const filter = parseUsageQuery(query);
    // Story 20.7 round 2: this query is not in `Usage_Logs` (it would feed itself) but it shows the IP of
    // customers, so it leaves a `USAGE_LOG_QUERIED` event in the immutable chain, committed BEFORE any row
    // is read (once per admin and 15 minutes, no filter, no data): no trace, no data (503 AUDIT_UNAVAILABLE).
    await this.trail.note(req.user.id, 'USAGE_LOG_QUERIED', { strict: true });
    return this.reader.list(filter);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'State of the in-memory buffer of THIS instance',
    description:
      '`droppedSinceBoot` grows when the database cannot take the rows; it resets when the process restarts (one instance per environment, A101).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: UsageStatsDto })
  @ApiResponse(UNAUTH)
  stats(): UsageStatsDto {
    return this.buffer.stats();
  }
}
