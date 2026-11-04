import { fakeAudit } from '../../test/helpers/fake-audit.js';
import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
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
    $transaction?: ReturnType<typeof vi.fn>;
    customer: {
      updateMany?: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    customerSession: { deleteMany: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };
  let service: CustomerAuthService;
  /** Story 19.4: ConsentService double (its own rules are in consent.service.spec.ts). */
  let consent: {
    assertAccepted: ReturnType<typeof vi.fn>;
    recordConsents: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    consent = {
      assertAccepted: vi
        .fn()
        .mockResolvedValue({ now: new Date(), versions: {} }),
      recordConsents: vi.fn().mockResolvedValue(3),
    };
    vi.mocked(argon2.hash).mockClear();
    signUpEmail = vi.fn();
    signInEmail = vi.fn();
    prisma = {
      customer: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
      customerSession: { deleteMany: vi.fn() },
      $executeRaw: vi.fn().mockResolvedValue(0),
    };
    sendMail = vi.fn().mockResolvedValue(undefined);
    verification = {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    };
    prisma.customerVerification = verification;
    prisma.$transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb({ $executeRaw: vi.fn(), customerVerification: verification }),
    );
    prisma.customer.updateMany = vi.fn();
    resetPassword = vi.fn();
    requestPasswordReset = vi.fn().mockResolvedValue(undefined);
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
      {
        get: (k: string, d: unknown) =>
          k === 'REGISTER_MIN_DURATION_MS' ? 0 : d,
      } as never,
      consent as never,
      fakeAudit(prisma as never),
    );
  });

  it('register: new email resolves without extra hashing', async () => {
    prisma.customer.count.mockResolvedValue(1);
    signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
    await expect(service.register(DTO)).resolves.toBeUndefined();
    expect(argon2.hash).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    expect(verification.create).toHaveBeenCalledTimes(1);
    expect(
      (sendMail.mock.calls[0] as [{ subject: string }])[0].subject,
    ).toMatch(/Verify/);
  });

  describe('Story 19.4: consent', () => {
    const ACCEPT = {
      ...DTO,
      acceptedTermsVersion: 3,
      acceptedPrivacyVersion: 2,
      ageDeclared: true,
    };

    it('validates BEFORE creating the account, with the email-independent fields only', async () => {
      consent.assertAccepted.mockRejectedValue(
        new ApiException(400, 'CONSENT_REQUIRED', 'x', {
          missing: ['ageDeclared'],
        }),
      );
      await expect(service.register(DTO)).rejects.toMatchObject({
        status: 400,
      });
      expect(signUpEmail).not.toHaveBeenCalled();
      expect(consent.recordConsents).not.toHaveBeenCalled();
      expect(consent.assertAccepted).toHaveBeenCalledWith(
        expect.anything(),
        { terms: undefined, privacy: undefined },
        { declared: undefined },
      );
    });

    it('a new account records TERMS, PRIVACY and AGE_DECLARATION (REGISTER) for its id', async () => {
      prisma.customer.count.mockResolvedValue(1);
      signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
      await service.register(ACCEPT);
      expect(consent.assertAccepted).toHaveBeenCalledWith(
        expect.anything(),
        { terms: 3, privacy: 2 },
        { declared: true },
      );
      expect(consent.recordConsents).toHaveBeenCalledTimes(1);
      expect(consent.recordConsents.mock.calls[0][1]).toMatchObject({
        context: 'REGISTER',
        customerId: 'u1',
        keys: ['terms', 'privacy'],
        age: true,
      });
    });

    it('a duplicate email (error or synthetic success) writes no consent', async () => {
      signUpEmail.mockResolvedValue({ user: { id: 'fake' } });
      prisma.customer.count.mockResolvedValue(0);
      await service.register(ACCEPT);
      expect(consent.recordConsents).not.toHaveBeenCalled();
      signUpEmail.mockRejectedValue(
        new APIError('UNPROCESSABLE_ENTITY', {
          code: 'USER_ALREADY_EXISTS',
          message: 'exists',
        }),
      );
      prisma.customer.count.mockResolvedValue(1);
      await service.register(ACCEPT);
      expect(consent.recordConsents).not.toHaveBeenCalled();
    });

    it('if the evidence cannot be written the new customer is deleted and the answer is a 500', async () => {
      prisma.customer.count.mockResolvedValue(1);
      signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
      consent.recordConsents.mockRejectedValue(new Error('db down'));
      const del = vi.fn().mockResolvedValue({});
      (prisma.customer as Record<string, unknown>).delete = del;
      await expect(service.register(ACCEPT)).rejects.toMatchObject({
        status: 500,
      });
      expect(del).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(sendMail).not.toHaveBeenCalled(); // no verification mail for a removed account
    });
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

  describe('Story 20.6: anonymized accounts', () => {
    it('login with the reserved domain: the same generic 401 after ONE dummy hash, BetterAuth is never called', async () => {
      await expect(
        service.login('deleted+x@Anonymized.Invalid', 'whatever1'),
      ).rejects.toMatchObject({
        status: 401,
        response: { errorCode: 'INVALID_CUSTOMER_CREDENTIALS' },
      });
      expect(argon2.hash).toHaveBeenCalledTimes(1);
      expect(signInEmail).not.toHaveBeenCalled();
    });

    it('a login that raced the anonymization is revoked and answered with the generic 401', async () => {
      signInEmail.mockResolvedValue({
        headers: new Headers(),
        response: { user: { id: 'u1' } },
      });
      prisma.customer.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'x@y.co',
        anonymizedAt: new Date(),
      });
      await expect(service.login('x@y.co', 'whatever1')).rejects.toMatchObject({
        status: 401,
        response: { errorCode: 'INVALID_CUSTOMER_CREDENTIALS' },
      });
      // sessions and credentials of an anonymized account are deleted
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('login: the profile never carries anonymizedAt', async () => {
      signInEmail.mockResolvedValue({
        headers: new Headers(),
        response: { user: { id: 'u1' } },
      });
      prisma.customer.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.co',
        anonymizedAt: null,
      });
      const r = await service.login('a@b.co', 'x');
      expect(r.customer).not.toHaveProperty('anonymizedAt');
    });

    it('register with the reserved domain is 400 EMAIL_DOMAIN_NOT_ALLOWED before anything runs', async () => {
      await expect(
        service.register({ ...DTO, email: 'deleted+u@anonymized.invalid' }),
      ).rejects.toMatchObject({
        status: 400,
        response: { errorCode: 'EMAIL_DOMAIN_NOT_ALLOWED' },
      });
      expect(signUpEmail).not.toHaveBeenCalled();
      expect(consent.assertAccepted).not.toHaveBeenCalled();
    });

    it('forgotPassword counts only accounts that are not anonymized', async () => {
      prisma.customer.count.mockResolvedValue(0);
      await service.forgotPassword('a@b.co');
      expect(prisma.customer.count).toHaveBeenCalledWith({
        where: { email: 'a@b.co', anonymizedAt: null },
      });
      expect(requestPasswordReset).not.toHaveBeenCalled();
    });

    it('resendVerification: an anonymized account gets no token and no mail', async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'x',
        emailVerified: false,
        anonymizedAt: new Date(),
      });
      await service.resendVerification('a@b.co');
      await new Promise((r) => setTimeout(r, 20));
      expect(verification.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
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
    await new Promise((r) => setTimeout(r, 20));
  });

  describe('verifyEmail', () => {
    const row = (expiresAt: Date) => ({ id: 'r1', value: 'u1', expiresAt });

    it('valid token consumes the row and verifies the customer', async () => {
      verification.findFirst.mockResolvedValue(row(new Date(Date.now() + 1e5)));
      verification.deleteMany.mockResolvedValue({ count: 1 });
      await service.verifyEmail('tok');
      expect(prisma.customer.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', anonymizedAt: null },
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

  describe('Story 20.5: CUSTOMER_PASSWORD_RESET', () => {
    const withOwner = (value: string | null, expiresInMs = 60_000) => {
      const findVerificationValue = vi
        .fn()
        .mockResolvedValue(
          value === null
            ? null
            : { value, expiresAt: new Date(Date.now() + expiresInMs) },
        );
      (service as unknown as { customerAuth: unknown }).customerAuth = {
        $context: Promise.resolve({
          internalAdapter: { findVerificationValue },
        }),
        api: { resetPassword },
      };
      const events: unknown[] = [];
      (service as unknown as { audit: unknown }).audit = {
        transaction: vi.fn(
          async (
            fn: (tx: never, a: { add: (e: unknown) => void }) => Promise<void>,
          ) => {
            await fn(undefined as never, { add: (e) => void events.push(e) });
          },
        ),
      };
      return { findVerificationValue, events };
    };

    it('a successful reset emits one event for the owner of the token (no token, no email)', async () => {
      const { findVerificationValue, events } = withOwner('cust-1');
      resetPassword.mockResolvedValue({ status: true });
      await service.resetPassword('tok-123', 'longenough1');
      // the owner is read BEFORE BetterAuth consumes the token
      expect(findVerificationValue).toHaveBeenCalledWith(
        'reset-password:tok-123',
      );
      expect(events).toEqual([
        expect.objectContaining({
          actorType: 'CUSTOMER',
          actorId: 'cust-1',
          action: 'CUSTOMER_PASSWORD_RESET',
          entityId: 'cust-1',
          after: {
            customerId: 'cust-1',
            via: 'EMAIL_TOKEN',
            sessionsRevoked: true,
          },
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain('tok-123');
    });

    it('a rejected token emits nothing; an unknown or expired owner emits nothing', async () => {
      const a = withOwner('cust-1');
      resetPassword.mockRejectedValue(
        new APIError('BAD_REQUEST', { message: 'bad', code: 'INVALID_TOKEN' }),
      );
      await expect(
        service.resetPassword('t', 'longenough1'),
      ).rejects.toBeDefined();
      expect(a.events).toHaveLength(0);
      for (const owner of [withOwner(null), withOwner('cust-1', -1_000)]) {
        resetPassword.mockResolvedValue({ status: true });
        await service.resetPassword('t', 'longenough1');
        expect(owner.events).toHaveLength(0);
      }
    });

    it('an audit failure never undoes or refuses a reset that already happened (logged as an error)', async () => {
      withOwner('cust-1');
      resetPassword.mockResolvedValue({ status: true });
      (service as unknown as { audit: unknown }).audit = {
        transaction: vi.fn().mockRejectedValue(new Error('audit down')),
      };
      const err = vi
        .spyOn(
          (service as unknown as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      await expect(
        service.resetPassword('t', 'longenough1'),
      ).resolves.toBeUndefined();
      expect(err).toHaveBeenCalledTimes(1);
    });
  });

  describe('timing: no branch awaits work exclusive to the other', () => {
    const SLOW = 150;
    const slow = () => new Promise((r) => setTimeout(() => r({}), SLOW));
    const elapsed = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };

    it('forgotPassword: existing account returns as fast as the unknown one even if token generation is slow', async () => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      requestPasswordReset.mockImplementation(() => slow());
      prisma.customer.count.mockResolvedValue(1);
      const existing = await elapsed(() => service.forgotPassword('a@b.co'));
      prisma.customer.count.mockResolvedValue(0);
      const unknown = await elapsed(() => service.forgotPassword('a@b.co'));
      expect(existing).toBeLessThan(SLOW / 2);
      expect(unknown).toBeLessThan(SLOW / 2);
    });

    it('register: both branches are padded to the same minimum duration', async () => {
      const padded = new CustomerAuthService(
        prisma as never,
        { api: { signUpEmail } } as never,
        { sendMail } as never,
        {
          get: (k: string) =>
            k === 'REGISTER_MIN_DURATION_MS' ? 120 : 'http://x',
        } as never,
        consent as never,
        fakeAudit(prisma as never),
      );
      signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
      prisma.customer.count.mockResolvedValue(1);
      expect(await elapsed(() => padded.register(DTO))).toBeGreaterThanOrEqual(
        115,
      );
      prisma.customer.count.mockResolvedValue(0);
      expect(await elapsed(() => padded.register(DTO))).toBeGreaterThanOrEqual(
        115,
      );
    });

    it('register: new account does not await token creation nor mail; duplicate awaits the same lookup', async () => {
      signUpEmail.mockResolvedValue({ user: { id: 'u1' } });
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      verification.create.mockImplementation(() => slow());
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      sendMail.mockImplementation(() => slow());
      prisma.customer.count.mockResolvedValue(1);
      const fresh = await elapsed(() => service.register(DTO));
      prisma.customer.count.mockResolvedValue(0);
      const dup = await elapsed(() => service.register(DTO));
      expect(fresh).toBeLessThan(SLOW / 2);
      expect(dup).toBeLessThan(SLOW / 2);
      expect(prisma.customer.count).toHaveBeenCalledTimes(2);
    });
  });

  describe('resendVerification (Story 12.6, AC11)', () => {
    const SAMPLES = 40;
    const LOOKUP_MS = 2;
    const SLOW = 150;
    const slow = () => new Promise((r) => setTimeout(() => r({}), SLOW));
    const lookup = (row: unknown) => {
      const delayed = () =>
        new Promise((r) => setTimeout(() => r(row), LOOKUP_MS));
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      prisma.customer.findUnique.mockImplementation(delayed);
    };
    const UNVERIFIED = { id: 'u1', name: 'A', emailVerified: false };

    it('unverified: invalidates previous tokens, issues a new one and mails it', async () => {
      lookup(UNVERIFIED);
      await expect(
        service.resendVerification('a@b.co'),
      ).resolves.toBeUndefined();
      await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
      expect(verification.deleteMany).toHaveBeenCalledWith({
        where: {
          value: 'u1',
          identifier: { startsWith: 'email-verification:' },
        },
      });
      expect(verification.create).toHaveBeenCalledTimes(1);
    });

    it('unknown and already-verified: no token, no mail, same resolution', async () => {
      lookup(null);
      await expect(
        service.resendVerification('a@b.co'),
      ).resolves.toBeUndefined();
      lookup({ ...UNVERIFIED, emailVerified: true });
      await expect(
        service.resendVerification('a@b.co'),
      ).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(verification.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('timing: >=40 samples per branch, none awaits token creation or mail', async () => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      verification.create.mockImplementation(() => slow());
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      sendMail.mockImplementation(() => slow());
      const branches: Record<string, unknown> = {
        unknown: null,
        verified: { ...UNVERIFIED, emailVerified: true },
        unverified: UNVERIFIED,
      };
      const medians: Record<string, number> = {};
      for (const [name, row] of Object.entries(branches)) {
        lookup(row);
        const times: number[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          const t = performance.now();
          await service.resendVerification('a@b.co');
          times.push(performance.now() - t);
        }
        times.sort((a, b) => a - b);
        medians[name] = times[SAMPLES / 2];
        expect(times[SAMPLES - 1]).toBeLessThan(SLOW / 2);
      }
      const all = Object.values(medians);
      expect(Math.max(...all) - Math.min(...all)).toBeLessThan(5);
    });
  });
});
