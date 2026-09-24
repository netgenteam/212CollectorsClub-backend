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
 * stale until the token's 8h expiry.
 *
 * Story 7.2 (AD-11): `jti` is a random UUID minted once per `login` call
 * (never reused across tokens, even for the same AdminUser/concurrent
 * sessions) — it is this token's own identity, independent of `sub`, which
 * is what lets `POST /admin/auth/logout` revoke exactly ONE token (this
 * one) rather than every session belonging to that Admin. */
export interface AdminJwtPayload {
  sub: string;
  jti: string;
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
 *
 * Story 7.2 (AD-11, FR-21): also rejects a token whose `jti` was revoked
 * via `POST /admin/auth/logout`, checked here (not a separate guard/
 * middleware) so EVERY consumer of `AdminAuthGuard` — present and future,
 * across Epic 8/9/10 — gets revocation checking for free, the same as they
 * already get signature/expiry/deleted-user checking, with no extra
 * wiring. This runs on every single Admin-gated request, so it stays to
 * exactly one indexed Postgres lookup by primary key (`RevokedToken.jti`)
 * run IN PARALLEL with the existing AdminUser lookup (`Promise.all`, not
 * sequential) rather than adding a second round-trip's worth of latency.
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
    // Every token minted by AdminAuthService.login (Story 7.2 onward)
    // always carries a jti. A well-signed, non-expired token missing one
    // can only be a hand-crafted or pre-Story-7.2 token — fail closed
    // instead of running a revocation lookup that can never match one.
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      throw new UnauthorizedException();
    }

    const [admin, revoked] = await Promise.all([
      this.prisma.adminUser.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          username: true,
          email: true,
          roleTier: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.revokedToken.findUnique({ where: { jti: payload.jti } }),
    ]);
    if (!admin || revoked) {
      throw new UnauthorizedException();
    }
    return admin;
  }
}
