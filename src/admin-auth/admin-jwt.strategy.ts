import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-custom';
import type { AdminAuth } from '../auth-core/admin-auth.factory.js';
import { ADMIN_AUTH } from '../auth-core/auth-core.constants.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/** Extracts the raw `Authorization: Bearer <token>` value, or null. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  const match = header ? BEARER_PATTERN.exec(header) : null;
  return match ? match[1] : null;
}

/**
 * Story 12.2 (AD-27): the `'admin-jwt'` Passport strategy, kept under the
 * same name so `AdminAuthGuard` and every consumer module's
 * `PassportModule.register({ defaultStrategy: 'admin-jwt' })` stay
 * untouched. It now validates the BetterAuth session behind the bearer
 * token (signature, existence, 8h expiry) instead of a JWT + denylist.
 * Any failure (missing, malformed, tampered, expired, logged-out, token of
 * another domain) is a uniform 401.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    @Inject(ADMIN_AUTH) private readonly adminAuth: AdminAuth,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async validate(request: Request): Promise<AuthenticatedAdminUser> {
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    let userId: string | undefined;
    try {
      const session = await this.adminAuth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      userId = session?.user.id;
    } catch {
      throw new UnauthorizedException();
    }
    if (!userId) {
      throw new UnauthorizedException();
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        roleTier: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!admin) {
      throw new UnauthorizedException();
    }
    return admin;
  }
}
