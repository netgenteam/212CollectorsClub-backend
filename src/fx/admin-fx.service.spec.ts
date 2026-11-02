import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { FX_LOCK_BUDGET_MS, AdminFxService } from './admin-fx.service.js';

const lockErr = () =>
  Object.assign(new Error('Raw query failed. Code: `55P03`'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { code: '55P03' } } },
  });

const make = (tx: ReturnType<typeof vi.fn>) =>
  new AdminFxService({ $transaction: tx } as never, {} as never);
const body = (e: unknown) =>
  (e as { getResponse(): { errorCode: string } }).getResponse();

describe('AdminFxService lock budget (Story 19.1)', () => {
  it('runs both locking transactions with budget + 5 s timeout, under Nginx 60 s', async () => {
    const $transaction = vi.fn().mockResolvedValue({});
    const svc = make($transaction);
    await svc.acceptRejected('admin').catch(() => undefined);
    expect($transaction.mock.calls[0][1]).toEqual({
      maxWait: FX_LOCK_BUDGET_MS,
      timeout: FX_LOCK_BUDGET_MS + 5_000,
    });
    expect(FX_LOCK_BUDGET_MS).toBeGreaterThan(5_000);
    expect(FX_LOCK_BUDGET_MS).toBeLessThan(60_000);
  });

  it('sets lock_timeout as the first statement of the transaction', async () => {
    const executed: string[] = [];
    const tx = {
      $executeRaw: (s: TemplateStringsArray) => {
        executed.push(s.join('?'));
        return Promise.resolve(1);
      },
      $queryRaw: () => Promise.resolve([]),
    };
    const $transaction = vi.fn((fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    );
    await make($transaction as never)
      .acceptRejected('admin')
      .catch(() => undefined);
    expect(executed[0]).toContain("set_config('lock_timeout'");
  });

  it.each([
    ['55P03 on the lock', lockErr()],
    [
      'tx timeout P2028',
      new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
        code: 'P2028',
        clientVersion: 'test',
      }),
    ],
  ])('acceptRejected maps %s to 409 FX_SETTINGS_BUSY', async (_n, err) => {
    const svc = make(vi.fn().mockRejectedValue(err));
    const e = await svc.acceptRejected('admin').catch((x: unknown) => x);
    expect((e as { getStatus(): number }).getStatus()).toBe(
      HttpStatus.CONFLICT,
    );
    expect(body(e).errorCode).toBe('FX_SETTINGS_BUSY');
  });

  it('updateSettings maps 55P03 to 409 FX_SETTINGS_BUSY and leaves other errors alone', async () => {
    const svc = make(vi.fn().mockRejectedValue(lockErr()));
    const e = await svc
      .updateSettings({ source: 'MANUAL', manualVesPerUsd: 50 } as never, 'a')
      .catch((x: unknown) => x);
    expect(body(e).errorCode).toBe('FX_SETTINGS_BUSY');
    const boom = new Error('boom');
    const svc2 = make(vi.fn().mockRejectedValue(boom));
    await expect(svc2.acceptRejected('a')).rejects.toBe(boom);
  });
});
