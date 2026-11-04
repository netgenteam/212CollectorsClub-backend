import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import {
  LockBudget,
  isLockWaitExpired,
  isTxTimeout,
  lockedTxOptions,
} from '../common/lock-timeout.js';
import {
  AUDIT_CHAIN_LOCK_KEY,
  AUDIT_ERROR_CODE,
  AUDIT_LOCK_BUDGET_MS,
  AuditService,
} from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IdDocCryptoService } from './id-doc-crypto.service.js';
import { normalizeIdDoc } from './id-doc-normalize.js';

export type RevealField = 'recipient' | 'buyer';
export const REVEAL_FIELDS: readonly RevealField[] = ['recipient', 'buyer'];

export const ID_DOC_REVEAL_MAX_PER_HOUR_DEFAULT = 30;
export const ID_DOC_REVEAL_ACTION = 'ID_DOC_REVEALED' as const;

/** `ID_DOC_REVEAL_MAX_PER_HOUR`, read on every call; anything that is not a positive integer is the default (30). */
export function idDocRevealMaxPerHour(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env.ID_DOC_REVEAL_MAX_PER_HOUR ?? '').trim();
  return /^\d{1,6}$/.test(raw) && Number(raw) >= 1
    ? Number(raw)
    : ID_DOC_REVEAL_MAX_PER_HOUR_DEFAULT;
}

/** 429 with the seconds to wait (the controller turns it into `Retry-After`). */
export class IdDocRateLimitedError extends ApiException {
  constructor(
    readonly retryAfterSec: number,
    limit: number,
  ) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'ID_DOC_REVEAL_RATE_LIMITED',
      'Too many ID document reveals in the last hour. Try again later.',
      { limitPerHour: limit, retryAfterSec },
    );
  }
}

export type IntegrityReason =
  'DECRYPT_FAILED' | 'BLIND_MISMATCH' | 'BLIND_MISSING' | 'ENC_MALFORMED';

/** The stored value is not what its row says it is (moved ciphertext, edited row, bad key). */
export class IdDocIntegrityError extends ApiException {
  constructor(
    readonly field: RevealField,
    readonly reason: IntegrityReason,
  ) {
    super(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'ID_DOC_INTEGRITY_FAILED',
      'The stored ID document could not be verified, so it was not delivered. It has been reported.',
      { field, reason },
    );
  }
}

export interface RevealedIdDoc {
  /** Canonical value (`V-12345678`). */
  value: string;
  /**
   * True for a legacy value that never parsed (no type): it has no blind index, so it cannot be
   * cross-checked against the row. It is delivered (the admin needs it to fix the order) and the
   * flag says so.
   */
  unparsed: boolean;
}

const unavailable = (reason: string): ApiException =>
  new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    AUDIT_ERROR_CODE,
    'The audit log is unavailable; the ID document was not delivered. Retry in a few seconds.',
    { reason },
  );

/**
 * Story 20.4 (FR-125/126, AD-95/97): the ONLY code that hands the full cedula to a person (and,
 * later, the invoice generator). It uses `decrypt` (which throws), never `serialize` (which turns
 * every failure into a silent null), and it checks the value against the row's blind index.
 *
 * Why the check: the AAD of the ciphertext is constant (so the buyer can copy the recipient's
 * cipher and addresses can feed orders), which means a valid ciphertext can be MOVED to another
 * order and still decrypt. `blindIndexOf(decrypt(enc))` must equal the row's `...Blind`; if not,
 * nothing is delivered, the event is logged (order id and field only, never a value) and the
 * caller gets 500 ID_DOC_INTEGRITY_FAILED.
 *   - Parsed value: its blind index must be the row's (a NULL blind is also a failure).
 *   - Unparsed legacy value (blind NULL by construction): delivered with `unparsed: true`; the
 *     row's blind must still be NULL.
 *
 * Order of the flow: read + decrypt + verify IN MEMORY (nothing leaves) -> audit transaction of
 * its own, COMMITTED (rate limit counted inside the chain lock, then the `ID_DOC_REVEALED`
 * event, no value) -> only then the value is returned. No event, no delivery. A failed
 * integrity check never writes an event (nothing was revealed) and does not use a slot of the
 * hourly limit.
 *
 * Lock discipline (AD-99, "using it safely"): the transaction takes the chain-head lock, runs ONE
 * indexed count and inserts the event as its LAST statement through `AuditService.record`; there
 * is no other work between the lock and the commit. The count is the only extra under the lock;
 * its cost is measured in docs/deployment.md.
 */
@Injectable()
export class IdDocRevealService {
  private readonly logger = new Logger(IdDocRevealService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: IdDocCryptoService,
  ) {}

  /** Verifies a stored value against its blind index (pure given the crypto service; no I/O). */
  verifyStored(
    field: RevealField,
    enc: string,
    blind: string | null,
  ): RevealedIdDoc {
    if (!this.crypto.isEncrypted(enc)) {
      throw new IdDocIntegrityError(field, 'ENC_MALFORMED');
    }
    let value: string;
    try {
      value = this.crypto.decrypt(enc);
    } catch {
      throw new IdDocIntegrityError(field, 'DECRYPT_FAILED');
    }
    const n = normalizeIdDoc(value);
    if (!n) throw new IdDocIntegrityError(field, 'DECRYPT_FAILED');
    if (n.unparsed) {
      if (blind !== null)
        throw new IdDocIntegrityError(field, 'BLIND_MISMATCH');
      return { value: n.canonical, unparsed: true };
    }
    if (blind === null) throw new IdDocIntegrityError(field, 'BLIND_MISSING');
    if (this.crypto.blindIndexOf(n.canonical) !== blind) {
      throw new IdDocIntegrityError(field, 'BLIND_MISMATCH');
    }
    return { value: n.canonical, unparsed: false };
  }

  async revealOrderIdDoc(
    orderId: string,
    field: RevealField,
    admin: { id: string },
  ): Promise<RevealedIdDoc> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        recipientIdDoc: true,
        recipientIdDocEnc: true,
        recipientIdDocBlind: true,
        buyerIdDocEnc: true,
        buyerIdDocBlind: true,
      },
    });
    if (!order) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'ORDER_NOT_FOUND',
        'Order not found.',
      );
    }
    const enc =
      field === 'recipient' ? order.recipientIdDocEnc : order.buyerIdDocEnc;
    const blind =
      field === 'recipient' ? order.recipientIdDocBlind : order.buyerIdDocBlind;
    // `Enc ?? plain` (columns in transition, Story 20.3): only the recipient has a legacy plain column.
    const legacy = field === 'recipient' ? order.recipientIdDoc : null;

    let revealed: RevealedIdDoc;
    try {
      if (enc) {
        revealed = this.verifyStored(field, enc, blind);
      } else if (legacy && legacy.trim() !== '') {
        revealed = this.fromLegacy(field, legacy, blind);
      } else {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'ID_DOC_NOT_FOUND',
          'This order has no ID document for that field.',
          { field },
        );
      }
    } catch (err) {
      if (err instanceof IdDocIntegrityError) {
        // Reported: order id and field only; the value, the ciphertext and the keys never reach a log.
        this.logger.error(
          `ID_DOC_INTEGRITY_FAILED order=${orderId} field=${field} reason=${err.reason}`,
        );
      }
      throw err;
    }

    await this.commitRevealEvent(orderId, field, admin.id, revealed.unparsed);
    return revealed;
  }

  /** A legacy plain value (or a ciphertext left in the plain column during the transition). */
  private fromLegacy(
    field: RevealField,
    legacy: string,
    blind: string | null,
  ): RevealedIdDoc {
    if (this.crypto.isEncrypted(legacy)) {
      return this.verifyStored(field, legacy, blind);
    }
    const n = normalizeIdDoc(legacy);
    if (!n) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'ID_DOC_NOT_FOUND',
        'This order has no ID document for that field.',
        { field },
      );
    }
    return { value: n.canonical, unparsed: n.unparsed };
  }

  /**
   * The audit transaction of its own. Commits (or throws) BEFORE the value is returned.
   * 429 = the admin already revealed `ID_DOC_REVEAL_MAX_PER_HOUR` in the last hour (counted
   * inside the chain lock: exact under concurrency and across instances). 503 AUDIT_UNAVAILABLE
   * for anything else that stops the event from being written.
   */
  private async commitRevealEvent(
    orderId: string,
    field: RevealField,
    adminId: string,
    unparsed: boolean,
  ): Promise<void> {
    const limit = idDocRevealMaxPerHour();
    try {
      await this.prisma.$transaction(async (tx) => {
        const budget = new LockBudget(tx, AUDIT_LOCK_BUDGET_MS);
        await budget.arm();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY}::bigint)`;
        await budget.release();

        // Exact count of this admin's reveals in the last hour. Index use: the window start is
        // found on "Audit_Events_occurredAt_idx" (chain time is monotonic, so every row with
        // seq >= that row is inside the window) and the reveals are then range-scanned on
        // "Audit_Events_action_seq_idx"; nothing here reads the table by actor.
        const rows = await tx.$queryRaw<{ n: number; wait: number | null }[]>`
          WITH "w" AS (
            SELECT "seq" FROM "Audit_Events"
             WHERE "occurredAt" > statement_timestamp() - interval '1 hour'
             ORDER BY "occurredAt" ASC, "seq" ASC LIMIT 1
          )
          SELECT count(*)::int AS "n",
                 extract(epoch FROM (min("occurredAt") + interval '1 hour' - statement_timestamp()))::float8 AS "wait"
            FROM "Audit_Events"
           WHERE "action" = ${ID_DOC_REVEAL_ACTION}
             AND "seq" >= COALESCE((SELECT "seq" FROM "w"), 9223372036854775807)
             AND "actorId" = ${adminId}::uuid
             AND "occurredAt" > statement_timestamp() - interval '1 hour'`;
        if ((rows[0]?.n ?? 0) >= limit) {
          throw new IdDocRateLimitedError(
            Math.max(1, Math.ceil(rows[0]?.wait ?? 1)),
            limit,
          );
        }

        // LAST statement of the transaction: nothing after it but the commit.
        await this.audit.record(tx, {
          actorType: 'ADMIN',
          actorId: adminId,
          action: ID_DOC_REVEAL_ACTION,
          entityType: 'Order',
          entityId: orderId,
          after: unparsed ? { field, unparsed: true } : { field },
        });
      }, lockedTxOptions(AUDIT_LOCK_BUDGET_MS));
    } catch (err) {
      if (err instanceof ApiException) throw err;
      if (isTxTimeout(err)) {
        this.logger.warn('ID_DOC reveal audit transaction timed out (P2028)');
        throw unavailable('TX_TIMEOUT');
      }
      const lock = isLockWaitExpired(err);
      this.logger.error(
        `ID_DOC reveal audit failed (${lock ? 'lock wait expired' : 'database error'}): ${String(err)}`,
      );
      throw unavailable(lock ? 'LOCK_TIMEOUT' : 'WRITE_FAILED');
    }
  }
}
