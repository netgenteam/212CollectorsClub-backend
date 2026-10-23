import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { TcgSyncKind, TcgSyncStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A `RUNNING` row older than this belongs to a dead instance (AD-58). */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

export interface TcgSyncRunResult {
  status: Exclude<TcgSyncStatus, 'RUNNING'>;
  requestsUsed: number;
  cardsSynced: number;
  productsUpdated?: number;
  errorCount: number;
  errorSummary?: string | null;
  quotaExhausted: boolean;
  bigVariations?: Prisma.InputJsonValue;
  summary?: Prisma.InputJsonValue;
}

/**
 * Story 15.4 (AD-58): audit table + multi-instance lock. The partial unique
 * index on `status WHERE status='RUNNING'` allows one active run; nightly
 * (15.7) and ingest exclude each other through it.
 */
@Injectable()
export class TcgSyncRunService {
  private readonly logger = new Logger(TcgSyncRunService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Returns the new RUNNING row, or `null` when another run is active. */
  async tryStart(kind: TcgSyncKind) {
    await this.failStaleRuns();
    try {
      return await this.prisma.tcgSyncRun.create({
        data: { kind, status: 'RUNNING' },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
  }

  /** The currently active run (any kind), if any. */
  findRunning() {
    return this.prisma.tcgSyncRun.findFirst({ where: { status: 'RUNNING' } });
  }

  async failStaleRuns(): Promise<number> {
    const { count } = await this.prisma.tcgSyncRun.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) },
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorSummary: 'Marked FAILED: RUNNING for more than 2 hours',
      },
    });
    if (count > 0) {
      this.logger.warn(`Marked ${count} stale RUNNING sync run(s) as FAILED`);
    }
    return count;
  }

  async finish(id: string, result: TcgSyncRunResult): Promise<void> {
    await this.prisma.tcgSyncRun.update({
      where: { id },
      data: { ...result, finishedAt: new Date() },
    });
  }
}
