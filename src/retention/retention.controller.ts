import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
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
import { ApiException } from '../common/api-exception.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EXPIRED_SESSION_GRACE_DAYS,
  SAFETY_MARGIN_MS,
} from './retention-config.js';
import {
  RetentionConfigDto,
  RetentionRunAcceptedDto,
  RetentionRunsDto,
  RetentionRunsQueryDto,
  RunRetentionDto,
} from './retention.dto.js';
import { RetentionGuardError, RetentionService } from './retention.service.js';

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;

/** What the job never deletes, whatever the configuration (Story 20.8 AC3; a static test pins it). */
export const NEVER_PURGED = [
  'Orders (and the encrypted cedula of the invoice)',
  'Order_Lines, Order_Status_History, Order_Tracking_Events, Stock_Holds',
  'Proof_Of_Payments (rows and files)',
  'Consent_Records',
  'Audit_Events and Audit_Verifications',
  'Legal_* documents, versions and log',
  'Stripe_Webhook_Events',
  'Customers, Customer_Addresses and their accounts',
] as const;

/**
 * Story 20.8 (FR-132): manual run and read-only view of the retention job. Every route is behind
 * `AdminAuthGuard`. The run takes no parameter (a body with any property is 400).
 */
@ApiTags('admin-retention')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/retention')
export class RetentionController {
  constructor(
    private readonly service: RetentionService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run the retention job now (in the background)',
    description:
      'Same tasks, lock and limits as the daily cron; takes NO parameters (a body with any property is 400). Answers 202 with the id of the run once it holds the lock; follow it with GET /admin/retention/runs. 409 RETENTION_ALREADY_RUNNING when another run (this or another instance) holds the lock; 409 RETENTION_DISABLED when the job is off in this environment (RETENTION_PURGE_ENABLED); 409 RETENTION_REFUSED_TEST_ENV under NODE_ENV=test against a database that is not a throw-away e2e clone.',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, type: RetentionRunAcceptedDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'The body has a property (the run takes none)',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'RETENTION_ALREADY_RUNNING | RETENTION_DISABLED | RETENTION_REFUSED_TEST_ENV',
  })
  async run(
    @Req() req: RequestWithAdminUser,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- validated (and required to be empty) by the pipe, never read
    @Body(strictBody(RunRetentionDto)) _body: Readonly<RunRetentionDto>,
  ): Promise<RetentionRunAcceptedDto> {
    let out: Awaited<ReturnType<RetentionService['start']>>;
    try {
      out = await this.service.start('MANUAL', req.user.id);
    } catch (err) {
      // Under NODE_ENV=test the job refuses any database that is not a throw-away e2e clone: say so, not a bare 500.
      if (err instanceof RetentionGuardError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'RETENTION_REFUSED_TEST_ENV',
          'NODE_ENV=test: the retention job only runs against a throw-away e2e database clone (<name>_e2e_<epoch>_<hex>), and this database is not one. Run the server with NODE_ENV=development or production, or use the e2e suite, which clones the database for you.',
        );
      }
      throw err;
    }
    if (out.kind === 'busy') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'RETENTION_ALREADY_RUNNING',
        'A retention run is already in progress. Follow it in GET /admin/retention/runs.',
      );
    }
    if (out.kind === 'disabled') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'RETENTION_DISABLED',
        'The retention job is switched off in this environment (RETENTION_PURGE_ENABLED).',
      );
    }
    return { runId: out.runId };
  }

  @Get('runs')
  @ApiOperation({
    summary: 'Latest retention runs, newest first',
    description:
      'Per task: rows, duration, truncated, error code. `limit` 1..100, default 20.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '1..100, default 20',
  })
  @ApiResponse({ status: HttpStatus.OK, type: RetentionRunsDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'limit is not an integer between 1 and 100',
  })
  @ApiResponse(UNAUTH)
  async runs(@Query() q: RetentionRunsQueryDto): Promise<RetentionRunsDto> {
    const limit = q.limit ?? 20;
    const rows = await this.prisma.retentionRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return {
      limit,
      running: this.service.isRunning(),
      items: rows.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        triggeredById: r.triggeredById,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        status: r.status,
        tasks: Array.isArray(r.tasks)
          ? (r.tasks as unknown as RetentionRunsDto['items'][number]['tasks'])
          : [],
        effectiveNow: r.effectiveNow?.toISOString() ?? null,
        clockClamped: r.clockClamped,
        auditedAt: r.auditedAt?.toISOString() ?? null,
        errorSummary: r.errorSummary,
      })),
    };
  }

  @Get('config')
  @ApiOperation({
    summary: 'Periods in force and next run (read only)',
    description:
      'The configuration read at boot; nothing here can be changed through the API.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: RetentionConfigDto })
  @ApiResponse(UNAUTH)
  config(): RetentionConfigDto {
    const c = this.service.cfg;
    return {
      enabled: c.enabled,
      cron: c.cron,
      nextRunAt: this.service.nextRunAt()?.toISOString() ?? null,
      batchSize: c.batchSize,
      batchPauseMs: c.batchPauseMs,
      maxRunMs: c.maxRunMs,
      safetyMarginMinutes: SAFETY_MARGIN_MS / 60_000,
      maxClockAdvanceHours: c.maxClockAdvanceHours,
      periods: {
        sessionPiiDays: c.sessionPiiDays,
        expiredSessionDays: EXPIRED_SESSION_GRACE_DAYS,
        expiredTokenDays: c.expiredTokenDays,
        contactMonths: c.contactMonths,
        anonymousBasketsAtExpiry: true,
        usageLogDays: c.usageLogDays,
        productDailyStatsDays: 180,
        retentionRunsDays: c.retentionRunsDays,
      },
      tasks: this.service.taskNames(),
      neverPurged: [...NEVER_PURGED],
    };
  }
}
