import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import { Prisma } from '../generated/prisma/client.js';
import { CustomerAuthService } from './customer-auth.service.js';

vi.mock('argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('argon2')>();
  return { ...actual, hash: vi.fn(actual.hash) };
});

const DTO = { email: 'a@b.co', password: 'supersecret1', name: 'A' };

/** Story 12.3: registration anti-enumeration + login error mapping. */
describe('CustomerAuthService', () => {
  let signUpEmail: ReturnType<typeof vi.fn>;
  let signInEmail: ReturnType<typeof vi.fn>;
  let sendMail: ReturnType<typeof vi.fn>;
  let verification: Record<
    'create' | 'findFirst' | 'deleteMany',
    ReturnType<typeof vi.fn>
  >;
  let resetPassword: ReturnType<typeof vi.fn>;
  let requestPasswordReset: ReturnType<typeof vi.fn>;
  let prisma: {
    customerVerification?: unknown;
    customer: {
      updateMany?: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    customerSession: { deleteMany: ReturnType<typeof vi.fn> };
  };
  let service: CustomerAuthService;

  beforeEach(() => {
    vi.mocked(argon2.hash).mockClear();
    signUpEmail = vi.fn();
    signInEmail = vi.fn();
    prisma = {
      customer: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
      customerSession: { deleteMany: vi.fn() },
    };
    sendMail = vi.fn().mockResolvedValue(undefined);
    verification = {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    };
    prisma.customerVerification = verification;
    prisma.customer.updateMany = vi.fn();
    resetPassword = vi.fn();
    requestPasswordReset = vi.fn();
    service = new CustomerAuthService(
      prisma as never,
      {
        api: {
          signUpEmail,
          signInEmail,
          resetPassword,
          requestPasswordReset,
        },
      } as never,
      { sendMail } as never,
      { get: (_k: string, d: string) => d } as never,
    );
  });

  it('register: new email resolves without extra hashing', async () => {
    prisma.customer.count.mockResolvedValue(1);
    signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
    await expect(service.register(DTO)).resolves.toBeUndefined();
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(verification.create).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(
      (sendMail.mock.calls[0] as [{ subject: string }])[0].subject,
    ).toMatch(/Verify/);
  });

  it('register: duplicate email (BetterAuth error) resolves identically and pays a dummy hash', async () => {
    signUpEmail.mockRejectedValue(
      new APIError('UNPROCESSABLE_ENTITY', {
        message: 'exists',
        code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      }),
    );
    await expect(service.register(DTO)).resolves.toBeUndefined();
    expect(argon2.hash).toHaveBeenCalledTimes(1);
  });

  it('register: concurrent-duplicate (FAILED_TO_CREATE_USER / P2002) is swallowed only if the customer exists; other errors propagate', async () => {
    prisma.customer.count.mockResolvedValue(1);
    signUpEmail.mockRejectedValueOnce(
      new APIError('INTERNAL_SERVER_ERROR', {
        message: 'x',
        code: 'FAILED_TO_CREATE_USER',
      }),
    );
    await expect(service.register(DTO)).resolves.toBeUndefined();
    signUpEmail.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2002' }),
    );
    await expect(service.register(DTO)).resolves.toBeUndefined();

    prisma.customer.count.mockResolvedValue(0);
    signUpEmail.mockRejectedValueOnce(
      new APIError('INTERNAL_SERVER_ERROR', {
        message: 'x',
        code: 'FAILED_TO_CREATE_USER',
      }),
    );
    await expect(service.register(DTO)).rejects.toBeInstanceOf(APIError);
    signUpEmail.mockRejectedValueOnce(new Error('db down'));
    await expect(service.register(DTO)).rejects.toThrow('db down');
  });

  it('login: any BetterAuth APIError becomes the generic 401 INVALID_CUSTOMER_CREDENTIALS', async () => {
    signInEmail.mockRejectedValue(
      new APIError('UNAUTHORIZED', {
        message: 'bad',
        code: 'INVALID_EMAIL_OR_PASSWORD',
      }),
    );
    await expect(service.login('a@b.co', 'x')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_CUSTOMER_CREDENTIALS' },
    });
  });

  it('login: returns the profile and the Set-Cookie values', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'cc_session=abc; Path=/');
    signInEmail.mockResolvedValue({
      headers,
      response: { user: { id: 'u1' } },
    });
    prisma.customer.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.co' });
    await expect(service.login('a@b.co', 'x')).resolves.toEqual({
      customer: { id: 'u1', email: 'a@b.co' },
      setCookies: ['cc_session=abc; Path=/'],
    });
  });

  it('updateProfile: only name/phone reach Prisma; a vanished customer is 401', async () => {
    prisma.customer.update.mockResolvedValue({ id: 'u1' });
    await service.updateProfile('u1', { name: 'N' });
    expect(
      (prisma.customer.update.mock.calls[0][0] as { data: unknown }).data,
    ).toEqual({ name: 'N' });
    prisma.customer.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('gone', {
        code: 'P2025',
        clientVersion: 'x',
      }),
    );
    await expect(
      service.updateProfile('u1', { phone: null }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it('logout deletes by token with deleteMany (idempotent)', async () => {
    await service.logout('tok');
    expect(prisma.customerSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'tok' },
    });
  });

  it('register: duplicate sends the "already have an account" email and no token', async () => {
    signUpEmail.mockRejectedValue(
      new APIError('UNPROCESSABLE_ENTITY', {
        message: 'exists',
        code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      }),
    );
    await service.register(DTO);
    expect(verification.create).not.toHaveBeenCalled();
    expect(
      (sendMail.mock.calls[0] as [{ subject: string }])[0].subject,
    ).toMatch(/already have/);
  });

  it('register: synthetic success for an existing email (fake user id) sends the already-registered email', async () => {
    prisma.customer.count.mockResolvedValue(0);
    signUpEmail.mockResolvedValue({ user: { id: 'fake' } });
    await service.register(DTO);
    expect(verification.create).not.toHaveBeenCalled();
    expect(
      (sendMail.mock.calls[0] as [{ subject: string }])[0].subject,
    ).toMatch(/already have/);
  });

  it('register: mailer failure or token failure does not alter the outcome', async () => {
    prisma.customer.count.mockResolvedValue(1);
    signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
    sendMail.mockRejectedValue(new Error('smtp down'));
    await expect(service.register(DTO)).resolves.toBeUndefined();
    verification.create.mockRejectedValue(new Error('db'));
    await expect(service.register(DTO)).resolves.toBeUndefined();
  });

  describe('verifyEmail', () => {
    const row = (expiresAt: Date) => ({ id: 'r1', value: 'u1', expiresAt });

    it('valid token consumes the row and verifies the customer', async () => {
      verification.findFirst.mockResolvedValue(row(new Date(Date.now() + 1e5)));
      verification.deleteMany.mockResolvedValue({ count: 1 });
      await service.verifyEmail('tok');
      expect(prisma.customer.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { emailVerified: true },
      });
    });

    it.each([
      ['unknown', null, 0],
      ['expired', row(new Date(Date.now() - 1)), 1],
      ['lost the race', row(new Date(Date.now() + 1e5)), 0],
    ])('%s token -> INVALID_VERIFICATION_TOKEN', async (_n, found, count) => {
      verification.findFirst.mockResolvedValue(found);
      verification.deleteMany.mockResolvedValue({ count });
      await expect(service.verifyEmail('tok')).rejects.toMatchObject({
        response: { errorCode: 'INVALID_VERIFICATION_TOKEN' },
      });
      expect(prisma.customer.updateMany).not.toHaveBeenCalled();
    });
  });

  it('forgotPassword: unknown email does nothing, known one requests a reset', async () => {
    prisma.customer.count.mockResolvedValue(0);
    await expect(service.forgotPassword('x@y.co')).resolves.toBeUndefined();
    expect(requestPasswordReset).not.toHaveBeenCalled();
    prisma.customer.count.mockResolvedValue(1);
    await service.forgotPassword('x@y.co');
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('resetPassword: BetterAuth APIError -> INVALID_RESET_TOKEN', async () => {
    resetPassword.mockRejectedValue(
      new APIError('BAD_REQUEST', { message: 'bad', code: 'INVALID_TOKEN' }),
    );
    await expect(
      service.resetPassword('t', 'longenough1'),
    ).rejects.toMatchObject({
      response: { errorCode: 'INVALID_RESET_TOKEN' },
    });
  });
});
