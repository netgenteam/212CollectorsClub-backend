import { Logger } from '@nestjs/common';
import { VERIFICATION_PREFIX } from '../customer-auth/customer-auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminCustomersService } from './admin-customers.service.js';

function setup(customer: { id: string; emailVerified: boolean } | null) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    customer: {
      findUnique: vi.fn().mockResolvedValue(customer),
      update: vi.fn().mockResolvedValue({}),
    },
    customerVerification: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new AdminCustomersService(prisma as unknown as PrismaService);
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  return { tx, service, log };
}

describe('AdminCustomersService.verifyEmail (Story 13.1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifies, deletes only email-verification rows by value, logs (AC3/4/8)', async () => {
    const { tx, service, log } = setup({ id: 'c1', emailVerified: false });
    await expect(service.verifyEmail('a1', 'ana@example.com')).resolves.toEqual(
      { email: 'ana@example.com', emailVerified: true },
    );
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { emailVerified: true },
    });
    expect(tx.customerVerification.deleteMany).toHaveBeenCalledWith({
      where: { value: 'c1', identifier: { startsWith: VERIFICATION_PREFIX } },
    });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      event: 'MANUAL_EMAIL_VERIFY',
      adminId: 'a1',
      email: 'ana@example.com',
      outcome: 'verified',
    });
  });

  it('is idempotent: already_verified (AC5)', async () => {
    const { tx, service, log } = setup({ id: 'c1', emailVerified: true });
    await expect(service.verifyEmail('a1', 'ana@example.com')).resolves.toEqual(
      { email: 'ana@example.com', emailVerified: true },
    );
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(
      (JSON.parse(log.mock.calls[0][0] as string) as { outcome: string })
        .outcome,
    ).toBe('already_verified');
  });

  it('404 CUSTOMER_NOT_FOUND and logs not_found (AC6)', async () => {
    const { service, log } = setup(null);
    await expect(
      service.verifyEmail('a1', 'x@example.com'),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (JSON.parse(log.mock.calls[0][0] as string) as { outcome: string })
        .outcome,
    ).toBe('not_found');
  });
});
