import { EXPIRED_SESSION_GRACE_DAYS } from '../retention-config.js';
import { marginalClock } from '../retention-config.js';
import { runBatches } from '../retention-batch.js';
import type { RetentionTask } from '../retention.types.js';

/**
 * `revoked_tokens` (FR-131): `Revoked_Tokens` (the deprecated admin JWT denylist, Story 12.2: nothing
 * reads or writes it any more) whose `expiresAt` passed more than 7 days ago. No foreign key points at it.
 */
export const revokedTokensTask: RetentionTask = {
  name: 'revoked_tokens',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const days = EXPIRED_SESSION_GRACE_DAYS;
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "jti" FROM "Revoked_Tokens"
           WHERE "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Revoked_Tokens" r USING picked WHERE r."jti" = picked."jti"`,
    );
  },
};

/**
 * `verification_tokens`: `Customer_Verifications` (email verification and password-reset links, 1 hour
 * of life, deleted on use) whose `expiresAt` passed more than `PURGE_EXPIRED_TOKENS_DAYS` (default 1)
 * ago. `identifier` holds an address and `value` a customer id: an expired link has no use and is
 * personal data. A link that is still valid is never touched (`expiresAt` in the future).
 */
export const verificationTokensTask: RetentionTask = {
  name: 'verification_tokens',
  run(ctx) {
    const iso = marginalClock(ctx.asOf).toISOString();
    const days = ctx.cfg.expiredTokenDays;
    return runBatches(
      ctx,
      (tx, limit) =>
        tx.$executeRaw`
        WITH picked AS (
          SELECT "id" FROM "Customer_Verifications"
           WHERE "expiresAt" < (${iso}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
           ORDER BY "expiresAt" LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED)
        DELETE FROM "Customer_Verifications" v USING picked WHERE v."id" = picked."id"`,
    );
  },
};
