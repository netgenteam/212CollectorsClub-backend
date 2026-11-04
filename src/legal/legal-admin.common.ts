import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import {
  isLockWaitExpired,
  lockedTxOptions,
  LockBudget,
} from '../common/lock-timeout.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuditCollector, AuditService } from '../audit/audit.service.js';

/** Bound (ms) of every lock wait of the admin legal writes (DB `lock_timeout`). */
export const LEGAL_LOCK_BUDGET_MS = 10_000;

/** Admin identity snapshotted into drafts, versions and the audit log. */
export interface LegalActor {
  id: string;
  email: string;
}

export interface LegalDocRef {
  id: string;
  slug: string;
  title: string;
}

/**
 * SQLSTATE 23000 (`integrity_constraint_violation`, raised by the guard
 * trigger of `Legal_Document_Versions` when the number / effectiveFrom does
 * not fit) or P2002 / 23505 (unique `(documentId, versionNumber)`). With the
 * pg driver adapter Prisma reports raw-query errors as P2010 with the SQLSTATE
 * nested in `meta.driverAdapterError.cause` (message as a fallback).
 */
export function isVersionInsertRejected(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { code?: unknown; meta?: unknown; cause?: unknown };
  if (e.code === 'P2002' || e.code === '23000' || e.code === '23505') {
    return true;
  }
  let meta = '';
  try {
    meta = JSON.stringify(e.meta ?? '');
  } catch {
    /* fall through to the message */
  }
  return (
    /"(code|kind|originalCode)":"(23000|23505)"/.test(meta) ||
    /Legal_Document_Versions: |integrity_constraint_violation|\b2300[0]\b/.test(
      meta,
    ) ||
    /Legal_Document_Versions: |integrity_constraint_violation|Unique constraint/.test(
      err.message,
    ) ||
    (e.cause !== undefined && isVersionInsertRejected(e.cause))
  );
}

/** Prisma P2034 (deadlock / serialization failure, SQLSTATE 40P01 / 40001). */
const isDeadlockOrWriteConflict = (err: unknown): boolean =>
  err instanceof Error && (err as { code?: unknown }).code === 'P2034';

export const legalBusy = () =>
  new ApiException(
    HttpStatus.CONFLICT,
    'LEGAL_DOCUMENT_BUSY',
    'The legal document is being changed by someone else; try again in a moment.',
  );

export const legalVersionConflict = () =>
  new ApiException(
    HttpStatus.CONFLICT,
    'LEGAL_VERSION_CONFLICT',
    'Another publication changed the document at the same time; reload and retry.',
  );

export const legalDraftNotFound = () =>
  new ApiException(
    HttpStatus.NOT_FOUND,
    'LEGAL_DRAFT_NOT_FOUND',
    'This document has no draft.',
  );

export const legalDraftStale = (currentRevision: number | null) =>
  new ApiException(
    HttpStatus.CONFLICT,
    'LEGAL_DRAFT_STALE',
    'The draft changed since you loaded it; reload it and apply your edit again.',
    { currentRevision },
  );

/**
 * Interactive transaction with the lock waits bounded in the database. An
 * expired wait is 409 `LEGAL_DOCUMENT_BUSY`; a version INSERT rejected by the
 * database guard (race) is 409 `LEGAL_VERSION_CONFLICT` (retryable). Never 500.
 */
export async function legalTx<T>(
  audit: AuditService,
  run: (
    tx: Prisma.TransactionClient,
    budget: LockBudget,
    collector: AuditCollector,
  ) => Promise<T>,
): Promise<T> {
  try {
    // Story 20.5: the immutable events collected by `run` are flushed as the LAST statement of
    // this transaction (the document row lock is taken first, the chain lock last). A Prisma
    // tx timeout is re-thrown to be mapped to LEGAL_DOCUMENT_BUSY, as before.
    return await audit.transaction(
      async (tx, collector) => {
        const budget = new LockBudget(tx, LEGAL_LOCK_BUDGET_MS);
        await budget.arm();
        return run(tx, budget, collector);
      },
      { ...lockedTxOptions(LEGAL_LOCK_BUDGET_MS), onTimeout: 'rethrow' },
    );
  } catch (err) {
    if (err instanceof ApiException) throw err;
    if (isLockWaitExpired(err) || isDeadlockOrWriteConflict(err)) {
      throw legalBusy();
    }
    if (isVersionInsertRejected(err)) throw legalVersionConflict();
    throw err;
  }
}

type Reader = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** 404 `LEGAL_DOCUMENT_NOT_FOUND` when no row has that slug. */
export async function findLegalDoc(
  db: Reader,
  slug: string,
): Promise<LegalDocRef> {
  const [doc] = await db.$queryRaw<LegalDocRef[]>`
    SELECT "id", "slug", "title" FROM "Legal_Documents" WHERE "slug" = ${slug}`;
  if (!doc) {
    throw new ApiException(
      HttpStatus.NOT_FOUND,
      'LEGAL_DOCUMENT_NOT_FOUND',
      'Legal document not found.',
    );
  }
  return doc;
}

/**
 * FIRST statement of every write on a document: takes its row lock
 * (`FOR UPDATE`, bounded by the budget) and then lifts the caps. Publish locks
 * document -> draft; if edit/discard/restore locked draft -> document (the FK
 * check of the audit insert) the two orders would deadlock. One order, always
 * the document first; it also serializes writers of the same document.
 */
export async function lockLegalDoc(
  tx: Prisma.TransactionClient,
  budget: LockBudget,
  documentId: string,
): Promise<void> {
  await budget.arm();
  await tx.$queryRaw`SELECT "id" FROM "Legal_Documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
  await budget.release();
}
