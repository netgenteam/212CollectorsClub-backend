import { Prisma } from '../generated/prisma/client.js';

/**
 * Story 18.12 / 19.1: bounded lock waits for admin writes that queue on
 * `FOR UPDATE` / `pg_advisory_xact_lock`. The wait is bounded IN THE DATABASE
 * (`lock_timeout`): a Prisma tx timeout alone cannot fire because its ROLLBACK
 * would queue behind the blocked statement on the same connection.
 *
 * Usage:
 *   await prisma.$transaction(async (tx) => {
 *     const budget = new LockBudget(tx, BUDGET_MS);
 *     await budget.arm();  ...lock...  await budget.release();  ...write...
 *   }, lockedTxOptions(BUDGET_MS));
 *   // catch (err) { if (isLockWaitExpired(err)) throw <409 ..._BUSY> }
 */

/** Slack so the DB-side lock_timeout always fires before Prisma's tx timeout. */
export const TX_SLACK_MS = 5_000;

/** `$transaction` options matching a lock budget (maxWait = budget, timeout = budget + slack). */
export const lockedTxOptions = (budgetMs: number) => ({
  maxWait: budgetMs,
  timeout: budgetMs + TX_SLACK_MS,
});

type RawTx = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Transaction-wide bound for lock waits. `lock_timeout` alone is NOT enough:
 * when several sessions queue on the same row, Postgres hands the row's tuple
 * lock from waiter to waiter and each one then starts a FRESH lock wait, so
 * the n-th waiter can wait n x budget (measured: 2 concurrent callers = 50 s
 * with a 25 s budget). So each locking statement is armed with BOTH
 * `lock_timeout` and `statement_timeout` set to the time REMAINING until one
 * shared deadline, and `release()` lifts BOTH caps (statement_timeout and
 * lock_timeout, left armed with ~1 ms it would turn a brief wait of the write
 * phase into a spurious 409) once the last lock is held.
 *
 *   const budget = new LockBudget(tx, BUDGET_MS);
 *   await budget.arm();            // before EACH statement that can wait
 *   ...pg_advisory_xact_lock / FOR UPDATE...
 *   await budget.release();        // after the last lock
 */
export class LockBudget {
  private readonly deadline: number;

  constructor(
    private readonly tx: RawTx,
    budgetMs: number,
  ) {
    this.deadline = Date.now() + budgetMs;
  }

  async arm(): Promise<void> {
    const left = `${Math.max(1, Math.ceil(this.deadline - Date.now()))}ms`;
    await this.tx
      .$executeRaw`SELECT set_config('lock_timeout', ${left}, true), set_config('statement_timeout', ${left}, true)`;
  }

  async release(): Promise<void> {
    await this.tx
      .$executeRaw`SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)`;
  }
}

/**
 * Postgres lock_not_available (55P03, `lock_timeout`) or query_canceled
 * (57014, `statement_timeout`, see LockBudget). With `$queryRaw` + the pg
 * driver adapter Prisma reports P2010 and nests the SQLSTATE in
 * `meta.driverAdapterError.cause.code`; the message also says so.
 */
export const isLockTimeout = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const e = err as { code?: unknown; meta?: unknown; cause?: unknown };
  if (e.code === '55P03' || e.code === '57014') return true;
  let meta = '';
  try {
    meta = JSON.stringify(e.meta ?? '');
  } catch {
    /* unserializable meta: fall through to the message */
  }
  return (
    meta.includes('55P03') ||
    meta.includes('57014') ||
    /55P03|57014|lock timeout|statement timeout/i.test(err.message) ||
    (e.cause !== undefined && isLockTimeout(e.cause))
  );
};

/** Prisma P2028: interactive transaction timed out / could not start. */
export const isTxTimeout = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028';

/** True when the lock wait (or the tx budget) expired: answer 409 `*_BUSY`, never 500. */
export const isLockWaitExpired = (err: unknown): boolean =>
  isTxTimeout(err) || isLockTimeout(err);
