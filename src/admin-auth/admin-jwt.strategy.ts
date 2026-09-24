import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { StrategyOptionsWithoutRequest } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';

/** The exact shape `AdminAuthService.login` signs into the JWT — a minimal
 * subject reference, never any admin field beyond the id. Everything else
 * (`username`/`email`/`roleTier`) is re-read from Postgres on every request
 * below, not trusted from the token payload, so a later username/email
 * change on the AdminUser row is reflected immediately instead of staying
 * stale until the token's 8h expiry. */
export interface AdminJwtPayload {
  sub: string;
}

/**
 * Story 7.1 (AD-11): the `passport-jwt` Strategy `AdminAuthGuard`
 * (`src/common/admin-auth.guard.ts`) delegates to, registered under the
 * name `'admin-jwt'` (never the bare `'jwt'` default — this codebase may
 * grow other JWT-shaped auth later, e.g. a buyer account, and strategy
 * names are a single process-wide namespace in Passport). Verifies the
 * token's signature and expiry itself (`ignoreExpiration: false`, the
 * library's default) before `validate` is ever called — an
 * expired/tampered/malformed token never reaches this method at all.
 *
 * `validate` re-reads the AdminUser from Postgres with an explicit Prisma
 * `select` that never fetches `passwordHash` — the same "impossible to
 * accidentally leak" pattern as everywhere else this codebase touches
 * `AdminUser` (see `AuthenticatedAdminUser`'s own doc comment). Throwing
 * `UnauthorizedException` here (rather than returning a falsy value) both
 * covers "this AdminUser id no longer exists" (e.g. deleted after the
 * token was issued — no admin-deletion feature exists yet, but nothing
 * stops a direct DB edit) and is what `AuthGuard`'s `handleRequest` sees as
 * the `err` it turns into `AdminAuthGuard`'s own 401 `ApiException`.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('ADMIN_JWT_SECRET'),
    };
    super(options);
  }

  async validate(payload: AdminJwtPayload): Promise<AuthenticatedAdminUser> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
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
