import { describe, expect, it, vi } from 'vitest';
import {
  lockLiveCustomer,
  tryLockLiveCustomer,
} from './customer-write-lock.js';

/** Story 20.6 (D1): the single serialization point of every write to a customer account. */
function tx(rows: { anonymizedAt: Date | null }[]) {
  const calls: string[] = [];
  const client = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      calls.push(strings.join('?'));
      return Promise.resolve(rows);
    }),
  };
  return { client: client as never, calls };
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
});
