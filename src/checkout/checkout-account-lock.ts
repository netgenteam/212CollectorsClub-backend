import { HttpStatus } from '@nestjs/common';
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
 * would fail, so it is switched on by a column-existence probe (cached for a minute; run
 * OUTSIDE the transaction so the FOR SHARE stays the first statement of it). When 20.6 lands
 * nothing else has to change: the probe turns the lock on by itself (a restart is not needed
 * after the migration either, the cache expires). The e2e of the behaviour lives in 20.6.
 */
const PROBE_TTL_MS = 60_000;
let probe: { at: number; present: boolean } | null = null;

type Probe = {
  $queryRaw: (
    q: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<{ present: boolean }[]>;
};

export async function customerAnonymizedAtExists(
  db: Partial<Probe>,
  now: number = Date.now(),
): Promise<boolean> {
  if (probe && now - probe.at < PROBE_TTL_MS) return probe.present;
  let present = false;
  try {
    if (typeof db.$queryRaw === 'function') {
      const rows = await db.$queryRaw`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'Customers' AND column_name = 'anonymizedAt') AS "present"`;
      present = rows[0]?.present === true;
    }
  } catch {
    present = false;
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
