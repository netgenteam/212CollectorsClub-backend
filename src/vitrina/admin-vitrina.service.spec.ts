import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  AdminVitrinaService,
  PUT_LOCK_BUDGET_MS,
} from './admin-vitrina.service.js';
import { TX_TIMEOUT_MS } from './vitrina-scoring.service.js';

const DTO = {
  wSales: 30,
  wRevenue: 20,
  wVelocity: 20,
  wInterest: 20,
  wNovelty: 10,
} as never;

const p2028 = () =>
  new Prisma.PrismaClientKnownRequestError('tx timeout', {
    code: 'P2028',
    clientVersion: 'test',
  });

describe('AdminVitrinaService.updateAlgorithm tx budget (Story 18.9)', () => {
  it('runs the PUT transaction with its own lock budget (> 5 s default, well under Nginx 60 s)', async () => {
    const $transaction = vi.fn().mockRejectedValue(p2028());
    const svc = new AdminVitrinaService(
      { $transaction } as never,
      {} as never,
      {} as never,
    );
    await expect(svc.updateAlgorithm(DTO, 'admin')).rejects.toBeDefined();
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0][1]).toEqual({
      maxWait: PUT_LOCK_BUDGET_MS,
      timeout: PUT_LOCK_BUDGET_MS + 5_000,
    });
    expect(PUT_LOCK_BUDGET_MS).toBeGreaterThan(5000);
    // Story 18.12: must answer 409 before Nginx proxy_read_timeout (60 s).
    expect(PUT_LOCK_BUDGET_MS).toBeLessThan(60_000);
    expect(PUT_LOCK_BUDGET_MS).toBeLessThan(TX_TIMEOUT_MS);
  });

  it('answers 409 VITRINA_BUSY (not 500) when the lock wait times out', async () => {
    const svc = new AdminVitrinaService(
      { $transaction: vi.fn().mockRejectedValue(p2028()) } as never,
      {} as never,
      {} as never,
    );
    const err = await svc
      .updateAlgorithm(DTO, 'admin')
      .catch((e: unknown) => e);
    expect((err as { getStatus(): number }).getStatus()).toBe(
      HttpStatus.CONFLICT,
    );
    expect(
      (err as { getResponse(): { errorCode: string } }).getResponse().errorCode,
    ).toBe('VITRINA_BUSY');
  });

  it.each([
    [
      'driverAdapterError',
      {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { code: '55P03' } } },
      },
    ],
    [
      'message',
      {
        code: 'P2010',
        message:
          'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`',
      },
    ],
  ])('maps SQLSTATE 55P03 (%s) to 409 VITRINA_BUSY', async (_n, extra) => {
    const e = Object.assign(new Error('raw'), extra);
    const svc = new AdminVitrinaService(
      { $transaction: vi.fn().mockRejectedValue(e) } as never,
      {} as never,
      {} as never,
    );
    const err = await svc
      .updateAlgorithm(DTO, 'admin')
      .catch((x: unknown) => x);
    expect(
      (err as { getResponse(): { errorCode: string } }).getResponse().errorCode,
    ).toBe('VITRINA_BUSY');
  });

  it('other errors are not masked', async () => {
    const boom = new Error('boom');
    const svc = new AdminVitrinaService(
      { $transaction: vi.fn().mockRejectedValue(boom) } as never,
      {} as never,
      {} as never,
    );
    await expect(svc.updateAlgorithm(DTO, 'admin')).rejects.toBe(boom);
  });
});
