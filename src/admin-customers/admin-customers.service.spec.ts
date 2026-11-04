import { Logger } from '@nestjs/common';
import { VERIFICATION_PREFIX } from '../customer-auth/customer-auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminCustomersService } from './admin-customers.service.js';
import { fakeAudit } from '../../test/helpers/fake-audit.js';

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
  const audit = fakeAudit(prisma);
  const crypto = { hashEmail: vi.fn().mockReturnValue('h'.repeat(64)) };
  const service = new AdminCustomersService(
    prisma as unknown as PrismaService,
    audit,
    crypto as never,
  );
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  return { tx, service, log, audit };
}

describe('AdminCustomersService.verifyEmail (Story 13.1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifies, deletes only email-verification rows by value, logs (AC3/4/8)', async () => {
    const { tx, service, log, audit } = setup({
      id: 'c1',
      emailVerified: false,
    });
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
    // Story 20.5: one event, the email only hashed, the admin as actor.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      actorType: 'ADMIN',
      actorId: 'a1',
      action: 'CUSTOMER_EMAIL_VERIFIED_BY_ADMIN',
      entityId: 'c1',
      after: { customerId: 'c1', emailHash: 'h'.repeat(64), adminId: 'a1' },
    });
    expect(JSON.stringify(audit.events)).not.toContain('ana@example.com');
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      event: 'MANUAL_EMAIL_VERIFY',
      adminId: 'a1',
      email: 'ana@example.com',
      outcome: 'verified',
    });
  });

  it('is idempotent: already_verified (AC5)', async () => {
    const { tx, service, log, audit } = setup({
      id: 'c1',
      emailVerified: true,
    });
    await expect(service.verifyEmail('a1', 'ana@example.com')).resolves.toEqual(
      { email: 'ana@example.com', emailVerified: true },
    );
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(0); // nothing changed, nothing emitted
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
