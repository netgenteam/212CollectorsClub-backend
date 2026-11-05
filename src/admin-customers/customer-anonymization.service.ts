import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { redactReason } from '../audit/audit-payload.js';
import { ApiException } from '../common/api-exception.js';
import { looksLikeIdDocInText } from '../common/id-doc-not-in-url.js';
import { newIdDocInTextRegex } from '../common/id-doc-pattern.js';
import { anonymizedEmailFor, emailsMatch } from '../common/anonymized-email.js';
import {
  LockBudget,
  isDeadlock,
  isLockWaitExpired,
} from '../common/lock-timeout.js';
import { IdDocCryptoService } from '../crypto/id-doc-crypto.service.js';
import { UsageLogErasure } from '../usage/usage-erasure.service.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ANONYMIZE_REASON_MAX,
  ANONYMIZE_REASON_MIN,
} from './dto/anonymize-customer.dto.js';
import type {
  AnonymizeCustomerDto,
  AnonymizeCustomerResponseDto,
} from './dto/anonymize-customer.dto.js';

/** A, A99: the orders that still need the shopper or the admin. Everything else is final. */
export const ACTIVE_ORDER_STATUSES = [
  OrderStatus.PAYMENT_PROCESSING,
  OrderStatus.PENDING_VERIFICATION,
  OrderStatus.PAID,
] as const;

/** Max orders listed in the 409 (`details.orders`). `details.total` is the real number. */
export const MAX_ACTIVE_ORDERS_LISTED = 20;

/** Bounded wait for the row lock of the customer (database-side `lock_timeout`, shared deadline). */
export const ANONYMIZE_LOCK_BUDGET_MS = 10_000;
/** After the row is locked, every other wait of the transaction is bounded by this `lock_timeout`. */
const WRITE_LOCK_TIMEOUT = '5s';

/** Codes shown after a real anonymization (docs/deployment.md 18). */
export const ANONYMIZE_NOTICES = [
  'BROWSER_LOCAL_STORAGE_NOT_ERASED',
  'BACKUPS_KEEP_DATA_UNTIL_ROTATION',
] as const;

/** A story's own `\b[VEJPG]-?\d{6,9}\b`, widened to the separators a person really types. */
const REASON_ID_DOC =
  /(?<![A-Za-z0-9])[VEJPG][\s.-]{0,3}\d{6,9}(?![A-Za-z0-9])/i;
/** Venezuelan mobile numbers with or without the leading 0 / +58 and with separators. */
const REASON_PHONE =
  /(?<![\d])(?:\+?58[\s.-]?)?0?4(?:12|14|16|24|26)[\s.-]?\d{3}[\s.-]?\d{4}(?![\d])/;
/** A run of 7+ digits standing alone: a number, not a date (`2026-11-04`) nor a word-glued reference (`t1234567`). */
const REASON_LONG_DIGITS = /(?<![A-Za-z0-9])\d{7,}/;
/**
 * A number written the way cedulas are printed, with thousands separators (`12 345 678`, `1.234.567`):
 * 7+ digits in groups of three after the first one or two. Only that shape: `2026 11 04` and `10 20`
 * are not matched.
 */
const REASON_GROUPED_DIGITS = /(?<![A-Za-z0-9])\d{1,3}(?:[ .]\d{3}){2,}(?!\d)/;
/**
 * An id the system itself prints (an order id): not personal data, and a natural reference to give as
 * the motive. Taken out of the text before the digit checks, because a random UUID can hold a run of 7+
 * digits (`...-123456789012`) or look like a phone.
 */
const UUID_IN_TEXT =
  /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi;
const REASON_LONG_NUMBER_MESSAGE =
  'The reason must not contain a number of 7 or more digits, whether written together (1234567) or in groups separated by spaces or dots (12 345 678, 100.200.300): it could be an ID document or a phone number. Put letters right before the reference (TKT1234567) or split it with hyphens in groups of up to 6 digits (ZD-123-4567), and write dates as 2026-11-04.';
const UNICODE_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u00AD]/g;

/**
 * Digits of any script (Arabic-Indic `\u0663`, Extended Arabic-Indic, Devanagari, ...) as `0-9`: NFKC only
 * folds the full-width ones. The digit is the position inside its run of `\p{Nd}` code points (every
 * script lays its ten digits out in order).
 */
function asciiDigits(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0) as number;
    if (cp < 128) return ch;
    let start = cp;
    while (/^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((cp - start) % 10);
  });
}

/**
 * The text a person typed, folded to what it LOOKS like: NFKC (full-width `Ｖ`), every Unicode dash as
 * `-`, no zero-width or other format characters, whitespace runs as one space. Every check below runs on
 * this, so `V  12345678`, `Ｖ‐ 12345678` or `V\u200B12345678` are caught like `V-12345678`.
 */
export function foldReasonText(raw: string): string {
  return asciiDigits(raw.normalize('NFKC'))
    .replace(UNICODE_DASHES, '-')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the reason holds something shaped like an ID document (type letter, `CI`/`cedula`/`RIF` + number). */
export function reasonLooksLikeIdDoc(folded: string): boolean {
  return (
    REASON_ID_DOC.test(folded) ||
    looksLikeIdDocInText(folded) ||
    newIdDocInTextRegex().test(folded)
  );
}

function reasonOrThrow(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const length = Array.from(reason).length;
  if (length < ANONYMIZE_REASON_MIN || length > ANONYMIZE_REASON_MAX) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'ANONYMIZE_REASON_REQUIRED',
      `The reason is required: ${ANONYMIZE_REASON_MIN}-${ANONYMIZE_REASON_MAX} characters (who asked, through which channel, date or reference).`,
      { min: ANONYMIZE_REASON_MIN, max: ANONYMIZE_REASON_MAX },
    );
  }
  if (reason.includes('\u0000')) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'ANONYMIZE_REASON_REQUIRED',
      'The reason must be plain text (no NUL character).',
      { min: ANONYMIZE_REASON_MIN, max: ANONYMIZE_REASON_MAX },
    );
  }
  const folded = foldReasonText(reason).replace(UUID_IN_TEXT, 'uuid');
  if (reasonLooksLikeIdDoc(folded)) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'REASON_CONTAINS_ID_DOC',
      'The reason must not contain an ID document number. Describe the request (channel, date, reference) without personal data.',
    );
  }
  if (REASON_PHONE.test(folded)) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'REASON_CONTAINS_PERSONAL_DATA',
      'The reason must not contain a phone number. Describe the request (channel, date, reference) without personal data.',
    );
  }
  if (REASON_LONG_DIGITS.test(folded) || REASON_GROUPED_DIGITS.test(folded)) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'REASON_CONTAINS_PERSONAL_DATA',
      REASON_LONG_NUMBER_MESSAGE,
    );
  }
  // The reason is written to the immutable audit log. The log's own guard would mask an email,
  // phone, cedula or secret in it, but a masked log line is a worse record than a refused request.
  // (Checked on the text as typed AND on the folded one.)
  const { hits } = redactReason(reason.replace(UUID_IN_TEXT, 'uuid'));
  const { hits: foldedHits } = redactReason(folded);
  const all = [...hits, ...foldedHits];
  if (all.length > 0) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      all.includes('CEDULA')
        ? 'REASON_CONTAINS_ID_DOC'
        : 'REASON_CONTAINS_PERSONAL_DATA',
      'The reason must not contain an email, a phone number, an ID document or a secret. Describe the request (channel, date, reference) without personal data.',
    );
  }
  return reason;
}

/**
 * Story 20.6 (AD-98, FR-119..122, A82..A86, A99): "delete account" is an ANONYMIZATION of the
 * `Customers` row plus the physical deletion of everything that is only the person's (credentials,
 * sessions, address book, cart, wishlist, tokens). Orders and every fiscal or
 * evidential record are untouched. Table by table: `docs/deployment.md` 18.2.
 *
 * ONE transaction (`AuditService.transaction`, so the `CUSTOMER_ANONYMIZED` event is flushed as the
 * LAST statement, under the chain-head lock, after every business row is locked and written):
 *   1. `SELECT ... FROM "Customers" WHERE id = $1 FOR UPDATE`, bounded by `lock_timeout`. This is
 *      the lock of the checkout (`FOR SHARE`, AD-97): an order can never be created for an account
 *      while it is anonymized, and a checkout that already holds its share is waited for and then
 *      seen as an active order (409). No deadlock: the checkout takes the Customers lock FIRST and
 *      never waits for anything this transaction holds before that.
 *   2. already anonymized => 200 idempotent (no effect, no event).
 *   3. `confirmEmail` (normalized, constant-time) and `reason`.
 *   4. active orders => 409 with the list, rollback.
 *   5. the effects, with a `lock_timeout` of 5 s for each wait, and the event.
 * Nothing slow, no file and no network call, runs inside it.
 */
@Injectable()
export class CustomerAnonymizationService {
  private readonly logger = new Logger(CustomerAnonymizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: IdDocCryptoService,
    private readonly usageLogs: UsageLogErasure,
  ) {}

  async anonymize(
    adminId: string,
    customerId: string,
    dto: Readonly<AnonymizeCustomerDto>,
  ): Promise<AnonymizeCustomerResponseDto> {
    try {
      const result = await this.audit.transaction(
        async (tx, audit): Promise<AnonymizeCustomerResponseDto> => {
          const budget = new LockBudget(tx, ANONYMIZE_LOCK_BUDGET_MS);
          await budget.arm();
          const rows = await tx.$queryRaw<
            { id: string; email: string; anonymizedAt: Date | null }[]
          >`SELECT "id", "email", "anonymizedAt" FROM "Customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
          // Row locked: lift the statement cap and keep a lock_timeout for the deletes below.
          await tx.$executeRaw`SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', ${WRITE_LOCK_TIMEOUT}, true)`;

          const row = rows[0];
          if (!row) {
            throw new ApiException(
              HttpStatus.NOT_FOUND,
              'CUSTOMER_NOT_FOUND',
              'Customer not found.',
            );
          }
          if (row.anonymizedAt) {
            return {
              customerId,
              anonymizedAt: row.anonymizedAt.toISOString(),
              alreadyAnonymized: true,
              notices: [],
            };
          }

          // The answer never says what the real email is, nor how close the guess was.
          if (
            typeof dto.confirmEmail !== 'string' ||
            !emailsMatch(dto.confirmEmail, row.email)
          ) {
            throw new ApiException(
              HttpStatus.BAD_REQUEST,
              'ANONYMIZE_CONFIRMATION_MISMATCH',
              'The email typed does not match the account. Type the exact email of the account to confirm.',
            );
          }
          const reason = reasonOrThrow(dto.reason);

          const activeWhere = {
            customerId,
            status: { in: [...ACTIVE_ORDER_STATUSES] },
          };
          const activeCount = await tx.order.count({ where: activeWhere });
          const active = await tx.order.findMany({
            where: activeWhere,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: MAX_ACTIVE_ORDERS_LISTED,
            select: { id: true, status: true, createdAt: true },
          });
          const ordersRetained = await tx.order.count({
            where: { customerId },
          });
          const consentsRetained = await tx.consentRecord.count({
            where: { customerId },
          });
          if (activeCount > 0) {
            throw new ApiException(
              HttpStatus.CONFLICT,
              'ACCOUNT_HAS_ACTIVE_ORDERS',
              'The account has orders that are not in a final state. Resolve them first (nothing is cancelled or completed automatically).',
              {
                total: activeCount,
                orders: active.map((o) => ({
                  id: o.id,
                  status: o.status.toLowerCase(),
                  createdAt: o.createdAt.toISOString(),
                })),
              },
            );
          }

          const oldEmail = row.email;
          const verifications = await tx.customerVerification.deleteMany({
            where: {
              OR: [{ identifier: oldEmail }, { value: customerId }],
            },
          });
          const sessions = await tx.customerSession.deleteMany({
            where: { userId: customerId },
          });
          const accounts = await tx.customerAccount.deleteMany({
            where: { userId: customerId },
          });
          const addresses = await tx.customerAddress.deleteMany({
            where: { customerId },
          });
          // `...Item` rows fall by ON DELETE CASCADE.
          const carts = await tx.cart.deleteMany({ where: { customerId } });
          const wishlists = await tx.wishlist.deleteMany({
            where: { customerId },
          });
          // Story 20.7: the usage log holds the account's id and IP for 7 days. Deleted here, under the
          // Customers row lock; `afterCommit` below sweeps what the in-memory buffer could still bring
          // (docs/deployment.md 19.5).
          const usageLogs = await this.usageLogs.deleteInTx(tx, customerId);
          // `Contact_Inquiries` are NOT deleted (QA 20.6 round 2, decision of Angel: do not delete
          // records): the 12-month retention of Story 20.8 covers them. A formal claim may be
          // among them and there is no verified link between the form and the account.

          const updated = await tx.$queryRaw<{ anonymizedAt: Date }[]>`
            UPDATE "Customers"
               SET "email" = ${anonymizedEmailFor(customerId)},
                   "name" = 'Cuenta eliminada',
                   "phone" = NULL,
                   "image" = NULL,
                   "emailVerified" = false,
                   "anonymizedAt" = date_trunc('milliseconds', clock_timestamp()),
                   "anonymizedById" = ${adminId}::uuid,
                   "updatedAt" = date_trunc('milliseconds', clock_timestamp())
             WHERE "id" = ${customerId}::uuid
         RETURNING "anonymizedAt"`;

          // LAST: flushed by `audit.transaction` after this callback, under the chain lock. The
          // email is only ever a keyed hash; `reason` was checked above (and the log masks it too).
          audit.add({
            actorType: 'ADMIN',
            actorId: adminId,
            action: 'CUSTOMER_ANONYMIZED',
            entityType: 'Customer',
            entityId: customerId,
            after: {
              customerId,
              emailHash: this.crypto.hashEmail(oldEmail),
              addressesDeleted: addresses.count,
              sessionsRevoked: sessions.count,
              credentialsDeleted: accounts.count,
              verificationTokensDeleted: verifications.count,
              cartsDeleted: carts.count,
              wishlistsDeleted: wishlists.count,
              usageLogsDeleted: usageLogs,
              ordersRetained,
              consentRecordsRetained: consentsRetained,
            },
            reason,
          });

          return {
            customerId,
            anonymizedAt: updated[0].anonymizedAt.toISOString(),
            alreadyAnonymized: false,
            notices: [...ANONYMIZE_NOTICES],
          };
        },
        { onTimeout: 'rethrow', timeout: 30_000, maxWait: 10_000 },
      );
      // Committed: nothing of this account may come back from the memory of the usage log.
      if (!result.alreadyAnonymized) {
        await this.usageLogs.afterCommit(customerId);
      }
      return result;
    } catch (err) {
      if (err instanceof ApiException) throw err;
      if (isLockWaitExpired(err) || isDeadlock(err)) {
        this.logger.warn(
          `anonymize ${customerId} could not get its locks in time: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new ApiException(
          HttpStatus.CONFLICT,
          'ANONYMIZE_BUSY',
          'The account is being used by another operation (a checkout, a login or another admin). Nothing was changed: retry in a few seconds.',
        );
      }
      throw err;
    }
  }
}
