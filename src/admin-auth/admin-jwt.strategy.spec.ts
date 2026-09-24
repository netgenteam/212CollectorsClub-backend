import { UnauthorizedException } from '@nestjs/common';
import { AdminJwtStrategy } from './admin-jwt.strategy.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Story 7.1. `validate` is the one place a JWT payload turns into the
 * `request.user` object every `AdminAuthGuard`-gated route sees — proves
 * it re-reads the AdminUser from Postgres with a `select` that can never
 * include `passwordHash` (rather than trusting the payload/DB row shape
 * blindly), and that a payload whose `sub` no longer matches any AdminUser
 * (e.g. deleted after the token was issued) is rejected, not silently
 * passed through as `undefined`.
 */
const TOKEN_JTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('AdminJwtStrategy', () => {
  let prisma: {
    adminUser: { findUnique: ReturnType<typeof vi.fn> };
    revokedToken: { findUnique: ReturnType<typeof vi.fn> };
  };
  let configService: { getOrThrow: ReturnType<typeof vi.fn> };
  let strategy: AdminJwtStrategy;

  beforeEach(() => {
    prisma = {
      adminUser: { findUnique: vi.fn() },
      revokedToken: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    configService = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    strategy = new AdminJwtStrategy(configService as never, prisma as never);
  });

  it('resolves the safe AdminUser (no passwordHash) for a payload whose sub matches an existing AdminUser and whose jti is not revoked', async () => {
    const safeAdmin = {
      id: ADMIN_ID,
      username: 'admin',
      email: 'admin@212collectorsclub.test',
      roleTier: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.adminUser.findUnique.mockResolvedValue(safeAdmin);

    const result = await strategy.validate({ sub: ADMIN_ID, jti: TOKEN_JTI });

    expect(result).toBe(safeAdmin);
    expect(prisma.adminUser.findUnique).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      select: {
        id: true,
        username: true,
        email: true,
        roleTier: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(prisma.revokedToken.findUnique).toHaveBeenCalledWith({
      where: { jti: TOKEN_JTI },
    });
  });

  it('throws UnauthorizedException when the payload sub matches no AdminUser', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: ADMIN_ID, jti: TOKEN_JTI }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException when the payload is missing a jti (Story 7.2: fail closed rather than skip the revocation check)', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      username: 'admin',
      email: 'admin@212collectorsclub.test',
      roleTier: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      strategy.validate({ sub: ADMIN_ID } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.revokedToken.findUnique).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when the jti IS in RevokedToken, even though the AdminUser still exists and the JWT is otherwise valid (Story 7.2, AD-11)', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      username: 'admin',
      email: 'admin@212collectorsclub.test',
      roleTier: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.revokedToken.findUnique.mockResolvedValue({
      jti: TOKEN_JTI,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
    });

    await expect(
      strategy.validate({ sub: ADMIN_ID, jti: TOKEN_JTI }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
