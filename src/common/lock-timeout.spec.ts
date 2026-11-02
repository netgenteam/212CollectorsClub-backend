import { Prisma } from '../generated/prisma/client.js';
import {
  isLockTimeout,
  isLockWaitExpired,
  lockedTxOptions,
  LockBudget,
  TX_SLACK_MS,
} from './lock-timeout.js';

describe('lock-timeout helper', () => {
  it('tx options: maxWait = budget, timeout = budget + 5 s', () => {
    expect(lockedTxOptions(25_000)).toEqual({
      maxWait: 25_000,
      timeout: 25_000 + TX_SLACK_MS,
    });
  });

  it('recognises SQLSTATE 55P03 in every shape the adapter produces', () => {
    const viaMeta = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { code: '55P03' } } },
    });
    const viaMessage = new Error(
      'Code: `55P03`. canceling statement due to lock timeout',
    );
    const viaCause = new Error('wrapper', { cause: viaMessage });
    for (const e of [
      viaMeta,
      viaMessage,
      viaCause,
      Object.assign(new Error('x'), { code: '55P03' }),
    ]) {
      expect(isLockTimeout(e)).toBe(true);
      expect(isLockWaitExpired(e)).toBe(true);
    }
    expect(isLockTimeout(new Error('boom'))).toBe(false);
    expect(isLockTimeout('55P03')).toBe(false);
    expect(isLockWaitExpired(null)).toBe(false);
  });

  it('treats Prisma P2028 as an expired wait', () => {
    const e = new Prisma.PrismaClientKnownRequestError('tx', {
      code: 'P2028',
      clientVersion: 'test',
    });
    expect(isLockWaitExpired(e)).toBe(true);
  });

  it('LockBudget arms lock_timeout AND statement_timeout with the time left, then lifts the cap', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve(1);
      },
    };
    vi.useFakeTimers();
    try {
      const b = new LockBudget(tx as never, 25_000);
      await b.arm();
      vi.advanceTimersByTime(10_000);
      await b.arm();
      vi.advanceTimersByTime(20_000); // past the deadline: never 0 / negative
      await b.arm();
      await b.release();
    } finally {
      vi.useRealTimers();
    }
    expect(calls[0].sql).toContain("set_config('lock_timeout', ?, true)");
    expect(calls[0].sql).toContain("set_config('statement_timeout', ?, true)");
    expect(calls[0].values).toEqual(['25000ms', '25000ms']);
    expect(calls[1].values).toEqual(['15000ms', '15000ms']);
    expect(calls[2].values).toEqual(['1ms', '1ms']);
    expect(calls[3].sql).toContain(
      "set_config('statement_timeout', '0', true)",
    );
  });

  it('SQLSTATE 57014 (statement_timeout cap) also counts as an expired wait', () => {
    const e = Object.assign(new Error('Raw query failed'), {
      meta: { driverAdapterError: { cause: { code: '57014' } } },
    });
    expect(isLockWaitExpired(e)).toBe(true);
  });
});
