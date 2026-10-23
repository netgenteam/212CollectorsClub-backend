import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Story 15.9. `202` body of `POST /admin/tcg-master-cards/ingest`. */
export class StartIngestResponseDto {
  @ApiProperty({ format: 'uuid' })
  runId!: string;

  @ApiProperty({ enum: ['RUNNING'] })
  status!: 'RUNNING';
}

/** Story 15.9. One `Tcg_Sync_Runs` row (audit of an ingest/nightly run). */
export class TcgSyncRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['NIGHTLY', 'INGEST'] })
  kind!: string;

  @ApiProperty({ enum: ['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'] })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  startedAt!: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  finishedAt!: Date | null;

  @ApiProperty()
  requestsUsed!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Last known X-RateLimit-Remaining; null if never reported.',
  })
  quotaRemaining!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      '{created, updated, skipped, errors, requests, quotaExhausted}',
  })
  summary!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  errorSummary!: string | null;
}

/** Story 15.9. Body of `GET /admin/tcg-master-cards/stats`. */
export class TcgMasterCardStatsDto {
  @ApiProperty()
  totalCards!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { POKEMON: 1200 },
  })
  byFranchise!: Record<string, number>;

  @ApiProperty({ type: TcgSyncRunDto, nullable: true })
  lastRun!: TcgSyncRunDto | null;
}
