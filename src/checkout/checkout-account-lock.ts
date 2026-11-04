import { HttpStatus, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Story 20.4 (AC4, AD-97/98): the hook for "an anonymized account cannot check out".
 *
 * With a session, the FIRST statement of the checkout transaction is
 *   SELECT "anonymizedAt" FROM "Customers" WHERE id = $1 FOR SHARE
 * It conflicts with the `FOR UPDATE` of the anonymization (Story 20.6), so an order can never
 * be created for an account while it is being anonymized, and `anonymizedAt` not null is 401.
 *
 * `Customers.anonymizedAt` is added by Story 20.6. Until that migration exists the statement
 * would fail, so it is switched on by a column-existence probe (run OUTSIDE the transaction so
 * the FOR SHARE stays the first statement of it). When 20.6 lands nothing else has to change.
 *
 * Probe rules (a wrong "absent" is a FAIL-OPEN of the anonymization guard):
 *   - Only a DEFINITIVE answer is cached. An error is NEVER cached as "absent": it is checked
 *     again once, immediately; if that fails too the checkout is 503 CHECKOUT_UNAVAILABLE (fail
 *     closed). The probe is one catalog read: if it cannot run, the checkout transaction that
 *     follows would not run either, so this does not take down a sale that would have worked.
 *   - "Present" is cached for the life of the process (a column is not dropped by a release).
 *   - "Absent" is cached for only `ABSENT_TTL_MS` (10 s), not a minute. WINDOW: after the 20.6
 *     migration creates the column, a process that cached "absent" just before keeps checking out
 *     WITHOUT the lock for up to 10 s. That is harmless on its own (nothing anonymizes accounts
 *     before 20.6's code runs) and 20.6 ships with a restart, which clears the cache; but with
 *     several instances, apply the migration, restart ALL of them, and only then enable the
 *     anonymize endpoint (docs/deployment.md 16.9).
 *   - It reads `pg_catalog.pg_attribute`, not `information_schema.columns`, which hides columns
 *     the role has no privilege on (an invisible column would read as "absent" forever).
 * The e2e of the behaviour lives in 20.6.
 */
export const ABSENT_TTL_MS = 10_000;
let probe: { at: number; present: boolean } | null = null;

type Probe = {
  $queryRaw: (
    q: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<{ present: boolean }[]>;
};

const logger = new Logger('CheckoutAccountLock');

async function probeOnce(db: Partial<Probe>): Promise<boolean> {
  if (typeof db.$queryRaw !== 'function') throw new Error('no $queryRaw');
  const rows = await db.$queryRaw`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = to_regclass('"Customers"')
       AND a.attname = 'anonymizedAt' AND a.attnum > 0 AND NOT a.attisdropped) AS "present"`;
  return rows[0]?.present === true;
}

export async function customerAnonymizedAtExists(
  db: Partial<Probe>,
  now: number = Date.now(),
): Promise<boolean> {
  if (probe && (probe.present || now - probe.at < ABSENT_TTL_MS)) {
    return probe.present;
  }
  let present: boolean;
  try {
    present = await probeOnce(db);
  } catch (first) {
    try {
      present = await probeOnce(db);
    } catch {
      logger.error(
        `anonymizedAt probe failed twice (${String(first)}); checkout is refused (fail closed), nothing cached`,
      );
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'CHECKOUT_UNAVAILABLE',
        'The checkout is temporarily unavailable. Retry in a few seconds.',
      );
    }
  }
  probe = { at: now, present };
  return present;
}

/** Test hook: forget the cached probe. */
export function resetCustomerAnonymizedAtProbe(): void {
  probe = null;
}

/** Runs `SELECT "anonymizedAt" ... FOR SHARE` as the first statement; 401 for a gone or anonymized account. */
export async function lockCustomerForCheckout(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { anonymizedAt: Date | null }[]
  >`SELECT "anonymizedAt" FROM "Customers" WHERE "id" = ${customerId}::uuid FOR SHARE`;
  if (rows.length === 0 || rows[0].anonymizedAt !== null) {
    throw invalidCustomerTokenException();
  }
}

/** Story 20.4: 409 when the session of this request is not the account the storefront believes it is. */
export function assertExpectedCustomer(
  expected: string | null | undefined,
  actual: string | null,
): void {
  if (expected === undefined) return;
  const same =
    expected === null
      ? actual === null
      : actual !== null && expected.toLowerCase() === actual.toLowerCase();
  if (!same) {
    throw new ApiException(
      HttpStatus.CONFLICT,
      'CHECKOUT_ACCOUNT_MISMATCH',
      'The account of this session is not the one the checkout was prepared for. Reload your session and try again.',
    );
  }
}
