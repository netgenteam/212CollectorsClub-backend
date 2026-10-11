import { APIError } from 'better-auth/api';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client.js';
import { AdminAuthService } from './admin-auth.service.js';

vi.mock('argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_EMAIL = 'admin@212collectorsclub.test';
const REAL_PASSWORD = 'a-real-strong-admin-password';

/**
 * Story 7.1 / 12.2. Unit-level proof of the contract preserved by the
 * BetterAuth facade: identical 401 for unknown user and wrong password, a
 * dummy Argon2 verify on the unknown-user path, lookup by username OR
 * email, lazy provisioning of the credential account, and the unchanged
 * response shape.
 */
describe('AdminAuthService', () => {
  let prisma: {
    adminUser: { findFirst: ReturnType<typeof vi.fn> };
    adminAccount: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    adminSession: { deleteMany: ReturnType<typeof vi.fn> };
  };
  let adminAuth: { api: { signInEmail: ReturnType<typeof vi.fn> } };
  let service: AdminAuthService;
  let realPasswordHash: string;

  beforeAll(async () => {
    realPasswordHash = await argon2.hash(REAL_PASSWORD, {
      type: argon2.argon2id,
    });
  });

  beforeEach(() => {
    prisma = {
      adminUser: { findFirst: vi.fn() },
      adminAccount: {
        findFirst: vi.fn().mockResolvedValue({ password: 'x' }),
        create: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      adminSession: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    adminAuth = {
      api: {
        signInEmail: vi.fn().mockResolvedValue({
          headers: new Headers({ 'set-auth-token': 'session.signature' }),
        }),
      },
    };
    service = new AdminAuthService(prisma as never, adminAuth as never);
  });

  const existingAdmin = () => ({
    id: ADMIN_ID,
    email: ADMIN_EMAIL,
    passwordHash: realPasswordHash,
  });

  it('rejects with the generic INVALID_ADMIN_CREDENTIALS error when no AdminUser matches, still running a real Argon2 verify', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(null);
    const verifySpy = vi.mocked(argon2.verify);
    verifySpy.mockClear();

    await expect(
      service.login('nobody-with-this-username', 'whatever-password'),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        errorCode: 'INVALID_ADMIN_CREDENTIALS',
        message: 'Incorrect username/email or password.',
      },
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(adminAuth.api.signInEmail).not.toHaveBeenCalled();
  });

  it('rejects with the EXACT SAME error when BetterAuth refuses the password', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
    adminAuth.api.signInEmail.mockRejectedValue(
      new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }),
    );

    await expect(
      service.login('admin', 'the-wrong-password'),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        errorCode: 'INVALID_ADMIN_CREDENTIALS',
        message: 'Incorrect username/email or password.',
      },
    });
  });

  it('does not swallow unexpected (non-APIError) failures as bad credentials', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
    adminAuth.api.signInEmail.mockRejectedValue(new Error('db down'));

    await expect(service.login('admin', REAL_PASSWORD)).rejects.toThrow(
      'db down',
    );
  });

  it('looks up the AdminUser by EITHER username or email and signs in with the stored email', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    await service.login(ADMIN_EMAIL, REAL_PASSWORD);

    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: ADMIN_EMAIL }, { email: ADMIN_EMAIL }] },
      select: { id: true, email: true, passwordHash: true },
    });
    expect(adminAuth.api.signInEmail).toHaveBeenCalledWith({
      body: { email: ADMIN_EMAIL, password: REAL_PASSWORD },
      returnHeaders: true,
    });
  });

  it('returns the exact set-auth-token value with the unchanged 8h body shape', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    const result = await service.login('admin', REAL_PASSWORD);

    expect(result).toEqual({
      accessToken: 'session.signature',
      tokenType: 'Bearer',
      expiresIn: 28800,
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('lazily provisions the credential account from passwordHash when none exists', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
    prisma.adminAccount.findFirst.mockResolvedValue(null);

    await service.login('admin', REAL_PASSWORD);

    expect(prisma.adminAccount.create).toHaveBeenCalledWith({
      data: {
        userId: ADMIN_ID,
        accountId: ADMIN_ID,
        providerId: 'credential',
        password: realPasswordHash,
      },
    });
  });

  it('fills a password-less credential account instead of creating a duplicate', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
    prisma.adminAccount.findFirst.mockResolvedValue({ password: null });

    await service.login('admin', REAL_PASSWORD);

    expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
      where: { userId: ADMIN_ID, providerId: 'credential', password: null },
      data: { password: realPasswordHash },
    });
  });

  it('does not touch an account that already has a password', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    await service.login('admin', REAL_PASSWORD);

    expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
  });

  it('treats a P2002 from a concurrent provisioning as success, but rethrows anything else', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    prisma.adminAccount.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.login('admin', REAL_PASSWORD)).resolves.toMatchObject({
      tokenType: 'Bearer',
    });

    prisma.adminAccount.create.mockRejectedValueOnce(new Error('boom'));
    await expect(service.login('admin', REAL_PASSWORD)).rejects.toThrow('boom');
  });
});

/**
 * Story 12.2 (AD-27). `logout` deletes the session row behind the (already
 * guard-verified) signed bearer value; `deleteMany` keeps it idempotent.
 */
describe('AdminAuthService.logout', () => {
  let prisma: { adminSession: { deleteMany: ReturnType<typeof vi.fn> } };
  let service: AdminAuthService;

  beforeEach(() => {
    prisma = {
      adminSession: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    service = new AdminAuthService(prisma as never, {} as never);
  });

  it('deletes the session identified by the token part of the signed value', async () => {
    await service.logout('sessiontoken123.c2lnbmF0dXJl');

    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'sessiontoken123' },
    });
  });

  it('handles URL-encoded signed values (tokens may contain %2B/%3D)', async () => {
    await service.logout('sessiontoken123.c2ln%2BYXR1cmU%3D');

    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'sessiontoken123' },
    });
  });

  it('is idempotent: deleting an already-deleted session is not an error', async () => {
    prisma.adminSession.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.logout('abc.def')).resolves.toBeUndefined();
  });

  it('rejects with INVALID_ADMIN_TOKEN on a value with no signature part (defense in depth)', async () => {
    await expect(service.logout('garbage')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
    expect(prisma.adminSession.deleteMany).not.toHaveBeenCalled();
  });
});
