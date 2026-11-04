import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { TcgSyncKind, TcgSyncStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, AUDIT_ERROR_CODE } from '../audit/audit.service.js';
import { ApiException } from '../common/api-exception.js';
import { adminActor } from '../audit/audit-events.js';

function isAuditUnavailable(err: unknown): boolean {
  return (
    err instanceof ApiException &&
    (err.getResponse() as { errorCode?: string }).errorCode === AUDIT_ERROR_CODE
  );
}

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Closes the run row and, in the SAME transaction, writes ONE `DATA_IMPORT_RUN` event with the
   * counters (Story 20.5): never a row per card or per price (a nightly run touches thousands).
   * Cost: one extra INSERT under the chain lock per run (a few runs a day), no external call.
   * The actor is the admin who started it (admin ingest) or SYSTEM (nightly cron, CLI).
   *
   * The run row is also the sync LOCK (a `RUNNING` row blocks every other run for 2 h), so an
   * audit outage must not leave it open: if the event cannot be written the row is still closed
   * (plain update), the failure is logged as an error, and nothing else is lost.
   */
  async finish(
    id: string,
    result: TcgSyncRunResult,
    startedBy?: { id: string } | null,
  ): Promise<void> {
    const data = { ...result, finishedAt: new Date() };
    try {
      await this.audit.transaction(async (tx, audit) => {
        const row = await tx.tcgSyncRun.update({ where: { id }, data });
        const big = row.bigVariations;
        audit.add({
          ...adminActor(startedBy ?? null),
          action: 'DATA_IMPORT_RUN',
          entityType: 'TcgSyncRun',
          entityId: id,
          after: {
            runId: id,
            kind: row.kind,
            status: row.status,
            startedAt: row.startedAt.toISOString(),
            finishedAt: (row.finishedAt ?? data.finishedAt).toISOString(),
            requestsUsed: row.requestsUsed,
            cardsSynced: row.cardsSynced,
            productsUpdated: row.productsUpdated,
            errorCount: row.errorCount,
            quotaExhausted: row.quotaExhausted,
            bigVariations: Array.isArray(big) ? big.length : 0,
          },
        });
      });
    } catch (err) {
      if (!isAuditUnavailable(err)) throw err;
      this.logger.error(
        `DATA_IMPORT_RUN for sync run ${id} could not be audited; closing the run without the event: ${String(err)}`,
      );
      await this.prisma.tcgSyncRun.update({ where: { id }, data });
    }
  }
}
