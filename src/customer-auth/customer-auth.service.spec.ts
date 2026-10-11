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
  let prisma: {
    customer: {
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
    service = new CustomerAuthService(
      prisma as never,
      { api: { signUpEmail, signInEmail } } as never,
    );
  });

  it('register: new email resolves without extra hashing', async () => {
    signUpEmail.mockResolvedValue({});
    await expect(service.register(DTO)).resolves.toBeUndefined();
    expect(argon2.hash).not.toHaveBeenCalled();
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
});
