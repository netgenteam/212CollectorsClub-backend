import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `POST /admin/retention/run` takes NO parameters. The body is validated against this empty class with
 * `forbidNonWhitelisted`: any property (`days`, `olderThan`, `dryRun`...) is a 400, so nobody can send
 * a shorter period or a different clock. The periods are the server's configuration, read at boot.
 */
export class RunRetentionDto {}

export class RetentionRunsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class RetentionRunAcceptedDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id of the `Retention_Runs` row; the run continues in the background.',
  })
  runId!: string;
}

export class RetentionTaskResultDto {
  @ApiProperty({ example: 'anon_carts' }) name!: string;
  @ApiProperty() rows!: number;
  @ApiProperty() durationMs!: number;
  @ApiProperty({
    description:
      'Stopped at the time cap (or a row lock): the rest goes in the next run.',
  })
  truncated!: boolean;
  @ApiPropertyOptional({
    description: 'Error class and code only, never a message.',
  })
  error?: string;
}

export class RetentionRunDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['SCHEDULED', 'MANUAL'] }) trigger!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) triggeredById!:
    string | null;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) finishedAt!:
    string | null;
  @ApiProperty({ enum: ['RUNNING', 'OK', 'PARTIAL', 'FAILED'] })
  status!: string;
  @ApiProperty({ type: [RetentionTaskResultDto] })
  tasks!: RetentionTaskResultDto[];
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'The clock the run used for every cut-off.',
  })
  effectiveNow!: string | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'When RETENTION_PURGE_RUN was written; null = not yet (audit log was down).',
  })
  auditedAt!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'Failure code of the run itself, if any.',
  })
  errorSummary!: string | null;
}

export class RetentionRunsDto {
  @ApiProperty({ type: [RetentionRunDto] }) items!: RetentionRunDto[];
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'A run is going on in THIS process right now.' })
  running!: boolean;
}

export class RetentionPeriodsDto {
  @ApiProperty({ description: 'PURGE_SESSION_PII_DAYS (30..90).' })
  sessionPiiDays!: number;
  @ApiProperty({
    description:
      'Fixed: an expired session / revoked token is deleted this many days after expiring.',
  })
  expiredSessionDays!: number;
  @ApiProperty({ description: 'PURGE_EXPIRED_TOKENS_DAYS (1..30).' })
  expiredTokenDays!: number;
  @ApiProperty({ description: 'PURGE_CONTACT_MONTHS (3..60).' })
  contactMonths!: number;
  @ApiProperty({
    description:
      'Anonymous carts and wishlists go when they expire (their own 30-day sliding expiry).',
  })
  anonymousBasketsAtExpiry!: boolean;
  @ApiProperty({ description: 'PURGE_USAGE_LOG_DAYS (1..30).' })
  usageLogDays!: number;
  @ApiProperty({ description: 'Fixed by Epic 18.' })
  productDailyStatsDays!: number;
  @ApiProperty({ description: 'PURGE_RETENTION_RUNS_DAYS (90..3650).' })
  retentionRunsDays!: number;
}

export class RetentionConfigDto {
  @ApiProperty({
    description:
      'false: neither the cron nor the manual run purges (default outside production; RETENTION_PURGE_ENABLED).',
  })
  enabled!: boolean;
  @ApiProperty({
    description: 'RETENTION_PURGE_CRON, UTC; "off" = no schedule.',
  })
  cron!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) nextRunAt!:
    string | null;
  @ApiProperty() batchSize!: number;
  @ApiProperty() batchPauseMs!: number;
  @ApiProperty() maxRunMs!: number;
  @ApiProperty({ description: 'Added to every period (fixed).' })
  safetyMarginMinutes!: number;
  @ApiProperty() maxClockAdvanceHours!: number;
  @ApiProperty({ type: RetentionPeriodsDto }) periods!: RetentionPeriodsDto;
  @ApiProperty({ type: [String] }) tasks!: string[];
  @ApiProperty({ type: [String], description: 'What the job never deletes.' })
  neverPurged!: string[];
}
