import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { isTxTimeout } from '../common/lock-timeout.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AuditChainVerifier,
  VERIFY_DEFAULT_LIMIT,
} from './audit-chain-verifier.js';
import type {
  SqlRunner,
  VerifyMode,
  VerifyResult,
} from './audit-chain-verifier.js';
import { AuditService } from './audit.service.js';
import type { AuditEventInput } from './audit.service.js';
import { GENESIS_HASH } from './canonical-json.js';

/** Advisory lock: one verification at a time across instances (manual or cron). */
export const AUDIT_VERIFY_LOCK_KEY = 2120002;
/** A verification holds the lock for as long as it runs; far above 200.000 rows at 50.000 rows/min. */
const VERIFY_LOCK_TX_TIMEOUT_MS = 20 * 60_000;

export interface VerifyRequest {
  mode?: VerifyMode;
  fromSeq?: number;
  limit?: number;
  source: 'MANUAL' | 'CRON';
  actor: Pick<AuditEventInput, 'actorType' | 'actorId'>;
}

export interface VerifyResponse extends Omit<
  VerifyResult,
  'lastSeq' | 'lastHash'
> {
  verificationId: string;
  headSeq: number;
  headHash: string;
}

/**
 * Story 20.1 (FR-137): runs `AuditChainVerifier`, stores the outcome in
 * `Audit_Verifications` and appends `AUDIT_VERIFIED` (both in one audited tx).
 * Only one verification runs at a time (advisory try-lock held by an otherwise
 * idle transaction while the work uses other connections): a second caller gets
 * 409 `AUDIT_VERIFY_IN_PROGRESS` instead of stacking CPU work.
 */
@Injectable()
export class AuditVerifyService {
  private readonly logger = new Logger(AuditVerifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly verifier: AuditChainVerifier,
  ) {}

  runner(): SqlRunner {
    return (sql, params = []) =>
      this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
  }

  async run(req: VerifyRequest): Promise<VerifyResponse> {
    const mode: VerifyMode = req.mode ?? 'incremental';
    const startedAt = new Date();
    return this.withVerifyLock(async () => {
      const result = await this.verifier.verify(this.runner(), {
        mode,
        fromSeq: req.fromSeq,
        limit: req.limit ?? VERIFY_DEFAULT_LIMIT,
      });
      const id = await this.store(req, result, startedAt);
      const { lastSeq, lastHash, ...rest } = result;
      return {
        ...rest,
        verificationId: id,
        headSeq: lastSeq,
        headHash: lastHash,
      };
    });
  }

  private async store(
    req: VerifyRequest,
    r: VerifyResult,
    startedAt: Date,
  ): Promise<string> {
    const lastHash = r.lastSeq === 0 ? GENESIS_HASH : r.lastHash;
    return this.audit.transaction(async (tx, audit) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Audit_Verifications"
          ("startedAt","finishedAt","mode","source","fromSeq","toSeq","rows","result",
           "brokenSeq","expectedHash","foundHash","headSeq","headHash","partial")
        VALUES (${startedAt}::timestamptz, now(), ${r.mode}, ${req.source},
                ${r.checkedFrom}::bigint, ${r.checkedTo}::bigint, ${r.rows}::int,
                ${r.ok ? 'OK' : 'BROKEN'},
                ${r.brokenAt?.seq ?? null}::bigint,
                ${r.brokenAt && /^[0-9a-f]{64}$/.test(r.brokenAt.expected) ? r.brokenAt.expected : null},
                ${r.brokenAt?.found && /^[0-9a-f]{64}$/.test(r.brokenAt.found) ? r.brokenAt.found : null},
                ${r.lastSeq}::bigint, ${lastHash}, ${r.partial})
        RETURNING "id"::text AS "id"`;
      const id = rows[0].id;
      audit.add({
        actorType: req.actor.actorType,
        actorId: req.actor.actorId ?? null,
        action: 'AUDIT_VERIFIED',
        entityType: 'AUDIT_VERIFICATION',
        entityId: id,
        after: {
          mode: r.mode,
          source: req.source,
          fromSeq: r.checkedFrom,
          toSeq: r.checkedTo,
          rows: r.rows,
          result: r.ok ? 'OK' : 'BROKEN',
          partial: r.partial,
          ...(r.brokenAt
            ? { brokenSeq: r.brokenAt.seq, reason: r.brokenAt.reason }
            : {}),
        },
      });
      return id;
    });
  }

  private async withVerifyLock<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const got = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(${AUDIT_VERIFY_LOCK_KEY}::bigint) AS "locked"`;
          if (!got[0]?.locked) {
            throw new ApiException(
              HttpStatus.CONFLICT,
              'AUDIT_VERIFY_IN_PROGRESS',
              'Another verification of the audit chain is running.',
            );
          }
          return work();
        },
        { maxWait: 5_000, timeout: VERIFY_LOCK_TX_TIMEOUT_MS },
      );
    } catch (err) {
      if (isTxTimeout(err)) {
        this.logger.error('audit verification exceeded its transaction budget');
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'AUDIT_VERIFY_TIMEOUT',
          'The verification took too long; resume it with fromSeq = nextFromSeq.',
        );
      }
      throw err;
    }
  }
}
