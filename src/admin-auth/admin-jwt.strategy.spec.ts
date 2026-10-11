import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminJwtStrategy, extractBearerToken } from './admin-jwt.strategy.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

const requestWith = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

describe('extractBearerToken', () => {
  it('returns the exact value after "Bearer ", including dots and %-encoding', () => {
    expect(extractBearerToken(requestWith('Bearer abc.d%2Bef%3D'))).toBe(
      'abc.d%2Bef%3D',
    );
  });

  it('returns null for a missing header or another scheme', () => {
    expect(extractBearerToken(requestWith())).toBeNull();
    expect(extractBearerToken(requestWith('Basic abc'))).toBeNull();
    expect(extractBearerToken(requestWith('Bearer'))).toBeNull();
  });
});

/**
 * Story 12.2 (AD-27). `validate` turns a BetterAuth session (resolved from
 * the bearer token) into the `request.user` every AdminAuthGuard-gated route
 * sees: re-read from Postgres with a select that can never include
 * `passwordHash`, and any failure is a uniform 401.
 */
describe('AdminJwtStrategy', () => {
  let prisma: { adminUser: { findUnique: ReturnType<typeof vi.fn> } };
  let adminAuth: { api: { getSession: ReturnType<typeof vi.fn> } };
  let strategy: AdminJwtStrategy;

  const safeAdmin = {
    id: ADMIN_ID,
    username: 'admin',
    email: 'admin@212collectorsclub.test',
    roleTier: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = { adminUser: { findUnique: vi.fn() } };
    adminAuth = {
      api: {
        getSession: vi.fn().mockResolvedValue({ user: { id: ADMIN_ID } }),
      },
    };
    strategy = new AdminJwtStrategy(adminAuth as never, prisma as never);
  });

  it('resolves the safe AdminUser (no passwordHash) for a valid session and forwards the exact bearer value', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(safeAdmin);

    const result = await strategy.validate(requestWith('Bearer tok.sig%3D'));

    expect(result).toBe(safeAdmin);
    const call = adminAuth.api.getSession.mock.calls[0] as [
      { headers: Headers },
    ];
    expect(call[0].headers.get('authorization')).toBe('Bearer tok.sig%3D');
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

  it('rejects when there is no bearer token, without asking BetterAuth', async () => {
    await expect(strategy.validate(requestWith())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(adminAuth.api.getSession).not.toHaveBeenCalled();
  });

  it('rejects when BetterAuth finds no session (tampered, expired, logged out)', async () => {
    adminAuth.api.getSession.mockResolvedValue(null);

    await expect(
      strategy.validate(requestWith('Bearer x.y')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when BetterAuth throws', async () => {
    adminAuth.api.getSession.mockRejectedValue(new Error('boom'));

    await expect(
      strategy.validate(requestWith('Bearer x.y')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the AdminUser behind the session no longer exists', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);

    await expect(
      strategy.validate(requestWith('Bearer x.y')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
