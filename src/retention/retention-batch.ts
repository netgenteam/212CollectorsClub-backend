import { isDeadlock, isLockWaitExpired } from '../common/lock-timeout.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  RetentionContext,
  RetentionTaskOutcome,
} from './retention.types.js';

/** A batch gives up waiting for a row lock after this and ends the task (`truncated`); it never queues behind a checkout. */
export const BATCH_LOCK_WAIT_MS = 2_000;
/** And is cut by the database after this, whatever it is doing. */
export const BATCH_STATEMENT_MS = 20_000;

/**
 * Runs `statement` (ONE `DELETE` / `UPDATE` bounded by `LIMIT n`, returning the rows it changed) in its own short
 * transaction until a batch changes fewer rows than the batch size, the run must stop, or a lock wait
 * expires. Each batch is a transaction of its own (no lock outlives it), preceded by the pause.
 *
 * - `lock_timeout` / `statement_timeout` are transaction-local: they never leak into the pool.
 * - A lock wait that expires is NOT an error: it means a live request holds one of the rows (a checkout,
 *   an anonymization); the task ends `truncated` and the next run takes the rest.
 * - The purge statements of the tables the application role may UPDATE pick their rows with
 *   `FOR UPDATE SKIP LOCKED` (a row someone holds is skipped, never waited for). `Usage_Logs` cannot: the
 *   role has no UPDATE on it (found by the 20.7 run under the limited role), so `UsageLogPurgeService`
 *   deletes by id and relies on `lock_timeout`.
 */
export async function runBatches(
  ctx: RetentionContext,
  statement: (tx: Prisma.TransactionClient, limit: number) => Promise<number>,
): Promise<RetentionTaskOutcome> {
  const limit = ctx.cfg.batchSize;
  let rows = 0;
  for (;;) {
    if (ctx.shouldStop()) return { rows, truncated: true };
    let changed: number;
    try {
      changed = await ctx.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${BATCH_LOCK_WAIT_MS}ms`}, true), set_config('statement_timeout', ${`${BATCH_STATEMENT_MS}ms`}, true)`;
          return statement(tx, limit);
        },
        { maxWait: BATCH_LOCK_WAIT_MS, timeout: BATCH_STATEMENT_MS + 5_000 },
      );
    } catch (err) {
      // A deadlock (40P01) is the same story as an expired wait: somebody else owns a row. The batch rolled
      // back whole; stop and let the next run retry rather than fight a live request.
      if (isLockWaitExpired(err) || isDeadlock(err))
        return { rows, truncated: true };
      throw err;
    }
    rows += changed;
    ctx.addRows(changed);
    if (changed < limit) return { rows, truncated: false };
    await ctx.pause();
  }
}
