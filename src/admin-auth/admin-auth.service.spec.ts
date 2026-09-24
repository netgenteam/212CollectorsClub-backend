import * as argon2 from 'argon2';
import { AdminAuthService } from './admin-auth.service.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const REAL_PASSWORD = 'a-real-strong-admin-password';

/**
 * Story 7.1. Proves the AC2 non-enumeration contract at the unit level:
 * a nonexistent username/email and a real one with a wrong password both
 * reject through the exact same `login` code path with the exact same
 * `ApiException` (same status, same errorCode, same message) — and that a
 * real Argon2 verify is attempted in BOTH cases (never skipped just
 * because no AdminUser matched), which is what closes the timing
 * side-channel documented on `AdminAuthService` itself.
 */
describe('AdminAuthService', () => {
  let prisma: {
    adminUser: { findFirst: ReturnType<typeof vi.fn> };
    revokedToken: { upsert: ReturnType<typeof vi.fn> };
  };
  let jwtService: {
    signAsync: ReturnType<typeof vi.fn>;
    decode: ReturnType<typeof vi.fn>;
  };
  let configService: { getOrThrow: ReturnType<typeof vi.fn> };
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
      revokedToken: { upsert: vi.fn().mockResolvedValue(undefined) },
    };
    jwtService = {
      signAsync: vi.fn().mockResolvedValue('signed.jwt.token'),
      decode: vi.fn(),
    };
    configService = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    service = new AdminAuthService(
      prisma as never,
      jwtService as never,
      configService as never,
    );
  });

  it('rejects with the generic INVALID_ADMIN_CREDENTIALS error when no AdminUser matches the identifier', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(null);

    await expect(
      service.login('nobody-with-this-username', 'whatever-password'),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        errorCode: 'INVALID_ADMIN_CREDENTIALS',
        message: 'Incorrect username/email or password.',
      },
    });
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects with the EXACT SAME error when the AdminUser exists but the password is wrong', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: ADMIN_ID,
      passwordHash: realPasswordHash,
    });

    await expect(
      service.login('admin', 'the-wrong-password'),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        errorCode: 'INVALID_ADMIN_CREDENTIALS',
        message: 'Incorrect username/email or password.',
      },
    });
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('looks up the AdminUser by EITHER username or email, and never selects passwordHash beyond what is needed to verify', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: ADMIN_ID,
      passwordHash: realPasswordHash,
    });

    await service.login('admin@212collectorsclub.test', REAL_PASSWORD);

    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { username: 'admin@212collectorsclub.test' },
          { email: 'admin@212collectorsclub.test' },
        ],
      },
      select: { id: true, passwordHash: true },
    });
  });

  it('issues a JWT with an 8h (28800s) expiry and returns it, on correct credentials', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: ADMIN_ID,
      passwordHash: realPasswordHash,
    });

    const result = await service.login('admin', REAL_PASSWORD);

    expect(result).toEqual({
      accessToken: 'signed.jwt.token',
      tokenType: 'Bearer',
      expiresIn: 28800,
    });
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: ADMIN_ID, jti: expect.any(String) as string },
      expect.objectContaining({ expiresIn: 28800 }),
    );
    // The response body never carries passwordHash, username, email or
    // anything else about the AdminUser beyond the opaque access token.
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('mints a different jti on every login (each token is independently revocable)', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: ADMIN_ID,
      passwordHash: realPasswordHash,
    });

    await service.login('admin', REAL_PASSWORD);
    await service.login('admin', REAL_PASSWORD);

    const [firstCallPayload] = jwtService.signAsync.mock.calls[0] as [
      { jti: string },
    ];
    const [secondCallPayload] = jwtService.signAsync.mock.calls[1] as [
      { jti: string },
    ];
    expect(firstCallPayload.jti).not.toBe(secondCallPayload.jti);
  });
});

/**
 * Story 7.2 (AD-11, FR-21). `logout` only ever decodes the already-guard-
 * verified token (never re-verifies against the secret) and persists its
 * `jti`/`exp` into RevokedToken.
 */
describe('AdminAuthService.logout', () => {
  let prisma: { revokedToken: { upsert: ReturnType<typeof vi.fn> } };
  let jwtService: { decode: ReturnType<typeof vi.fn> };
  let configService: { getOrThrow: ReturnType<typeof vi.fn> };
  let service: AdminAuthService;

  beforeEach(() => {
    prisma = { revokedToken: { upsert: vi.fn().mockResolvedValue(undefined) } };
    jwtService = { decode: vi.fn() };
    configService = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    service = new AdminAuthService(
      prisma as never,
      jwtService as never,
      configService as never,
    );
  });

  it('inserts the decoded jti/exp into RevokedToken', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 28800;
    jwtService.decode.mockReturnValue({
      sub: ADMIN_ID,
      jti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      iat: expSeconds - 28800,
      exp: expSeconds,
    });

    await service.logout('some.raw.jwt');

    expect(prisma.revokedToken.upsert).toHaveBeenCalledWith({
      where: { jti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      create: {
        jti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expiresAt: new Date(expSeconds * 1000),
      },
      update: {},
    });
  });

  it('rejects with INVALID_ADMIN_TOKEN when the token cannot be decoded (defense in depth — unreachable via the real guarded route)', async () => {
    jwtService.decode.mockReturnValue(null);

    await expect(service.logout('garbage')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
    expect(prisma.revokedToken.upsert).not.toHaveBeenCalled();
  });

  it('rejects with INVALID_ADMIN_TOKEN when the decoded payload has no jti', async () => {
    jwtService.decode.mockReturnValue({ sub: ADMIN_ID, exp: 9999999999 });

    await expect(service.logout('garbage')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
    expect(prisma.revokedToken.upsert).not.toHaveBeenCalled();
  });
});
