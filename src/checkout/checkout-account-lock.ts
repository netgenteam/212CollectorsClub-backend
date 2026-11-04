import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Story 20.4 (AC4, AD-97/98) and 20.6: "an anonymized account cannot check out".
 *
 * With a session, the FIRST statement of the checkout transaction is
 *   SELECT "anonymizedAt" FROM "Customers" WHERE id = $1 FOR SHARE
 * It conflicts with the `FOR UPDATE` of the anonymization (Story 20.6, `CustomerAnonymizationService`),
 * so an order can never be created for an account while it is being anonymized, and
 * `anonymizedAt` not null is 401. Proven against the real lock by
 * `test/customer-anonymize.e2e-spec.ts` (anonymize vs checkout, `Promise.all`, both orders of
 * arrival, no deadlock).
 *
 * Story 20.6 RETIRED the column-existence probe this file used to carry (cached "absent" for 10 s,
 * "present" for life): the column now ships with the same release, so there is nothing to probe and
 * no window in which a process could check out without the lock. The price is an order of
 * deployment, which `deploy/deploy.sh` already follows: MIGRATE BEFORE RESTARTING. A build started
 * against a database that still lacks `Customers.anonymizedAt` fails the checkouts that have a
 * session (the statement errors: closed, never open) until the migration is applied; guests are
 * not affected. (`docs/deployment.md` 18.1.)
 */
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
