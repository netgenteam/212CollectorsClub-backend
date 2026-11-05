import { describe, expect, it, vi } from 'vitest';
import {
  lockLiveCustomer,
  tryLockLiveCustomer,
} from './customer-write-lock.js';

/** Story 20.6 (D1): the single serialization point of every write to a customer account. */
function tx(rows: { anonymizedAt: Date | null }[], failWith?: Error) {
  const calls: string[] = [];
  const all: string[] = [];
  const client = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      all.push(sql);
      calls.push(sql);
      if (failWith) return Promise.reject(failWith);
      return Promise.resolve(rows);
    }),
    $executeRaw: vi.fn((strings: TemplateStringsArray) => {
      all.push(strings.join('?'));
      return Promise.resolve(1);
    }),
  };
  return { client: client as never, calls, all };
}

describe('lockLiveCustomer / tryLockLiveCustomer', () => {
  it('SHARE by default and FOR UPDATE on request, one statement that reads anonymizedAt', async () => {
    const a = tx([{ anonymizedAt: null }]);
    await lockLiveCustomer(a.client, 'u1');
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]).toMatch(
      /SELECT "anonymizedAt" FROM "Customers" WHERE "id" = \?::uuid FOR SHARE$/,
    );
    const b = tx([{ anonymizedAt: null }]);
    await lockLiveCustomer(b.client, 'u1', 'UPDATE');
    expect(b.calls[0]).toMatch(/FOR UPDATE$/);
  });

  it('an anonymized or a missing account is 401 INVALID_CUSTOMER_TOKEN', async () => {
    for (const rows of [[{ anonymizedAt: new Date() }], []]) {
      await expect(
        lockLiveCustomer(tx(rows).client, 'u1'),
      ).rejects.toMatchObject({
        status: 401,
        response: { errorCode: 'INVALID_CUSTOMER_TOKEN' },
      });
    }
  });

  it('try-variant answers false instead of throwing', async () => {
    expect(
      await tryLockLiveCustomer(tx([{ anonymizedAt: null }]).client, 'u1'),
    ).toBe(true);
    expect(
      await tryLockLiveCustomer(
        tx([{ anonymizedAt: new Date() }]).client,
        'u1',
      ),
    ).toBe(false);
    expect(await tryLockLiveCustomer(tx([]).client, 'u1')).toBe(false);
  });

  it('Story 20.6a: caps lock_timeout for the lock, restores it after, and an expired wait is 409 ACCOUNT_BUSY', async () => {
    const a = tx([{ anonymizedAt: null }]);
    await lockLiveCustomer(a.client, 'u1');
    expect(a.all).toHaveLength(3);
    expect(a.all[0]).toMatch(
      /current_setting\('lock_timeout'\).*set_config\('lock_timeout'/,
    );
    expect(a.all[1]).toMatch(/FOR SHARE$/);
    expect(a.all[2]).toMatch(/set_config\('lock_timeout'/);
    for (const err of [
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
      Object.assign(new Error('x'), { meta: { cause: '57014' } }),
    ]) {
      await expect(
        lockLiveCustomer(tx([], err).client, 'u1'),
      ).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'ACCOUNT_BUSY' },
      });
      await expect(
        tryLockLiveCustomer(tx([], err).client, 'u1'),
      ).rejects.toMatchObject({ status: 409 });
    }
    // anything else is not disguised
    await expect(
      lockLiveCustomer(tx([], new Error('boom')).client, 'u1'),
    ).rejects.toThrow('boom');
  });
});
