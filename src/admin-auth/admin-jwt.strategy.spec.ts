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
describe('AdminJwtStrategy', () => {
  let prisma: { adminUser: { findUnique: ReturnType<typeof vi.fn> } };
  let configService: { getOrThrow: ReturnType<typeof vi.fn> };
  let strategy: AdminJwtStrategy;

  beforeEach(() => {
    prisma = { adminUser: { findUnique: vi.fn() } };
    configService = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    strategy = new AdminJwtStrategy(configService as never, prisma as never);
  });

  it('resolves the safe AdminUser (no passwordHash) for a payload whose sub matches an existing AdminUser', async () => {
    const safeAdmin = {
      id: ADMIN_ID,
      username: 'admin',
      email: 'admin@212collectorsclub.test',
      roleTier: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.adminUser.findUnique.mockResolvedValue(safeAdmin);

    const result = await strategy.validate({ sub: ADMIN_ID });

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
  });

  it('throws UnauthorizedException when the payload sub matches no AdminUser', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);

    await expect(strategy.validate({ sub: ADMIN_ID })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
