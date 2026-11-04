import { createHash, createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client.js';
import { fakeAudit } from '../../test/helpers/fake-audit.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginFailureSummary } from './admin-login-failure-summary.js';
import { AdminLoginLimiter } from './admin-login-limiter.js';

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
    $transaction: ReturnType<typeof vi.fn>;
  };
  let audit: ReturnType<typeof fakeAudit>;
  let createSession: ReturnType<typeof vi.fn>;
  let adminAuth: { $context: Promise<unknown> };
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
        findFirst: vi.fn().mockResolvedValue({ password: realPasswordHash }),
        create: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      adminSession: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})),
    };
    audit = fakeAudit(prisma);
    createSession = vi
      .fn()
      .mockResolvedValue({ id: 'session-id-1', token: 'session-token' });
    adminAuth = {
      $context: Promise.resolve({
        secret: 'unit-secret',
        internalAdapter: { createSession },
      }),
    };
    service = new AdminAuthService(
      prisma as never,
      adminAuth as never,
      audit,
      {
        hashEmail: (e: string) =>
          createHash('sha256').update(e.toLowerCase()).digest('hex'),
      } as never,
      new AdminLoginLimiter({ get: () => undefined } as never),
      new AdminLoginFailureSummary(audit, { get: () => undefined } as never),
    );
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
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects with the EXACT SAME error when the password is wrong, creating no session', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    await expect(
      service.login('admin', 'the-wrong-password'),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        errorCode: 'INVALID_ADMIN_CREDENTIALS',
        message: 'Incorrect username/email or password.',
      },
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('looks up the AdminUser by EITHER username or email (exact match) and creates the session for its id', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    await service.login(ADMIN_EMAIL, REAL_PASSWORD);

    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: ADMIN_EMAIL }, { email: ADMIN_EMAIL }] },
      select: { id: true, passwordHash: true },
    });
    expect(createSession).toHaveBeenCalledWith(ADMIN_ID);
  });

  it('returns the signed session token (<token>.<base64 HMAC>) with the unchanged 8h body shape', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

    const result = await service.login('admin', REAL_PASSWORD);

    expect(result).toEqual({
      accessToken: `session-token.${createHmac('sha256', 'unit-secret').update('session-token').digest('base64')}`,
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

  describe('audit (Story 20.5, A104)', () => {
    it('LOGIN_ADMIN_OK is written in an audit transaction of its own, with the session id', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());

      await service.login('admin', REAL_PASSWORD);

      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        action: 'LOGIN_ADMIN_OK',
        actorType: 'ADMIN',
        actorId: ADMIN_ID,
        entityId: ADMIN_ID,
        after: {
          adminId: ADMIN_ID,
          method: 'password',
          sessionId: 'session-id-1',
        },
      });
    });

    it('is FAIL-CLOSED: when the audit write fails the session is deleted and the error (503) propagates', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
      const unavailable = Object.assign(new Error('AUDIT_UNAVAILABLE'), {
        status: 503,
      });
      prisma.$transaction.mockRejectedValueOnce(unavailable);

      await expect(service.login('admin', REAL_PASSWORD)).rejects.toBe(
        unavailable,
      );
      expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({
        where: { token: 'session-token' },
      });
    });

    it('LOGIN_ADMIN_FAILED is best-effort: still a 401 when the audit write fails, never the audit error', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
      prisma.$transaction.mockRejectedValue(new Error('audit down'));
      const err = vi
        .spyOn(
          (service as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.login('admin', 'wrong-password'),
      ).rejects.toMatchObject({
        status: 401,
        response: { errorCode: 'INVALID_ADMIN_CREDENTIALS' },
      });
      await vi.waitFor(() => expect(err).toHaveBeenCalled());
      expect(String(err.mock.calls[0][0])).toMatch(/LOGIN_ADMIN_FAILED/);
    });

    it('a failed login carries emailHash and never the typed value; unknown and wrong password differ only inside the event', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(null);
      await service.login('Someone@Example.com', 'x').catch(() => undefined);
      prisma.adminUser.findFirst.mockResolvedValue(existingAdmin());
      await service.login('admin', 'wrong').catch(() => undefined);

      await vi.waitFor(() => expect(audit.events).toHaveLength(2));
      const [unknown, known] = audit.events;
      expect(unknown).toMatchObject({
        action: 'LOGIN_ADMIN_FAILED',
        actorType: 'ANON',
        after: { reason: 'UNKNOWN_USER', adminFound: false },
      });
      expect(known).toMatchObject({
        entityId: ADMIN_ID,
        after: { reason: 'BAD_PASSWORD', adminFound: true },
      });
      expect(JSON.stringify(audit.events)).not.toMatch(/Someone|example\.com/i);
    });

    it('answers 429 BEFORE hashing once the per-user failure limit is reached', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(null);
      for (let i = 0; i < 5; i++) {
        await service.login('victim', 'x').catch(() => undefined);
      }
      const verifySpy = vi.mocked(argon2.verify);
      verifySpy.mockClear();
      await expect(service.login('victim', 'x')).rejects.toMatchObject({
        status: 429,
        response: { errorCode: 'ADMIN_LOGIN_RATE_LIMITED' },
      });
      expect(verifySpy).not.toHaveBeenCalled();
      expect(prisma.adminUser.findFirst).toHaveBeenCalledTimes(5);
    });
  });
});

/**
 * Story 12.2 (AD-27). `logout` deletes the session row behind the (already
 * guard-verified) signed bearer value; `deleteMany` keeps it idempotent.
 */
describe('AdminAuthService.logout', () => {
  let tx: { $queryRaw: ReturnType<typeof vi.fn> };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    adminSession: { deleteMany: ReturnType<typeof vi.fn> };
  };
  let audit: ReturnType<typeof fakeAudit>;
  let service: AdminAuthService;

  beforeEach(() => {
    tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: 'sess-1', userId: ADMIN_ID }]),
    };
    prisma = {
      $transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
      adminSession: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    audit = fakeAudit(prisma);
    service = new AdminAuthService(
      prisma as never,
      {} as never,
      audit,
      {} as never,
      new AdminLoginLimiter({ get: () => undefined } as never),
      new AdminLoginFailureSummary(audit, { get: () => undefined } as never),
    );
  });

  const deletedToken = () =>
    (tx.$queryRaw.mock.calls[0] as unknown[])[1] as string;

  it('deletes the session identified by the token part of the signed value and emits LOGOUT_ADMIN', async () => {
    await service.logout('sessiontoken123.c2lnbmF0dXJl');

    expect(deletedToken()).toBe('sessiontoken123');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: 'LOGOUT_ADMIN',
      actorType: 'ADMIN',
      actorId: ADMIN_ID,
      entityId: ADMIN_ID,
    });
  });

  it('handles URL-encoded signed values (tokens may contain %2B/%3D)', async () => {
    await service.logout('sessiontoken123.c2ln%2BYXR1cmU%3D');

    expect(deletedToken()).toBe('sessiontoken123');
  });

  it('is idempotent: deleting an already-deleted session is not an error and emits nothing', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(service.logout('abc.def')).resolves.toBeUndefined();
    expect(audit.events).toHaveLength(0);
  });

  it('revokes the session ANYWAY when the audit log is down: logged as an error, answers OK (a logout reduces exposure)', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('AUDIT_UNAVAILABLE'), { status: 503 }),
    );
    const err = vi
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(
      service.logout('sessiontoken123.c2lnbmF0dXJl'),
    ).resolves.toBeUndefined();
    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'sessiontoken123' },
    });
    expect(String(err.mock.calls[0][0])).toMatch(/LOGOUT_ADMIN/);
  });

  it('rejects with INVALID_ADMIN_TOKEN on a value with no signature part (defense in depth)', async () => {
    await expect(service.logout('garbage')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
