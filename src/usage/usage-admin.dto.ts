import { ApiProperty } from '@nestjs/swagger';

export class UsageLogItemDto {
  @ApiProperty({ description: 'Row id (bigint as a string); the cursor.' })
  id: string;
  @ApiProperty({ format: 'date-time' }) ts: string;
  @ApiProperty() method: string;
  @ApiProperty({
    description:
      'The route TEMPLATE (`/api/v1/orders/lookup/:token`), or `__unmatched__`. Never a path with ids, nor a query string.',
  })
  route: string;
  @ApiProperty() status: number;
  @ApiProperty() durationMs: number;
  @ApiProperty({ enum: ['ADMIN', 'CUSTOMER', 'ANON'] }) actorType: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Personal data: kept 7 days (security/diagnosis).',
  })
  ip: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent: string | null;
  @ApiProperty({ format: 'uuid' }) requestId: string;
}

export class UsagePageDto {
  @ApiProperty({ type: [UsageLogItemDto] }) items: UsageLogItemDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass it as `cursor` for the next page; null on the last.',
  })
  nextCursor: string | null;
}

export class UsageStatsDto {
  @ApiProperty({ description: 'Rows waiting in memory (this instance).' })
  buffered: number;
  @ApiProperty({
    description:
      'Rows discarded since this process started because the database could not take them (oldest first) or refused them.',
  })
  droppedSinceBoot: number;
  @ApiProperty({
    description:
      'Of `droppedSinceBoot`, the anonymous 404s: when the queue is full they are discarded FIRST, so a flood of them does not push out admin requests, 401/403 or failures.',
  })
  droppedLowPrioritySinceBoot: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the last row was discarded (null: none since boot).',
  })
  lastDropAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastFlushAt: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Last write error (short, redacted); null after a good write.',
  })
  lastFlushError: string | null;
  @ApiProperty({ description: 'Rows written since this process started.' })
  writtenSinceBoot: number;
}
