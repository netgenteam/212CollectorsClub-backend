import { HttpStatus, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ApiException } from './api-exception.js';

/**
 * Story 7.1 (AD-11, AD-14): the single JWT-shaped Admin the rest of this
 * codebase is ever allowed to see. Deliberately hand-typed here — never
 * `Prisma.AdminUserGetPayload<...>` or the raw generated `AdminUser`
 * model type — precisely so `passwordHash` cannot even be *typed* onto a
 * request object, let alone leak into a response. `AdminJwtStrategy`
 * (`src/admin-auth/admin-jwt.strategy.ts`) is the only place that builds a
 * value of this shape, and it does so from a Prisma `select` that never
 * fetches `passwordHash` in the first place — this type and that query are
 * meant to be read together.
 */
export interface AuthenticatedAdminUser {
  id: string;
  username: string;
  email: string;
  /** Reserved OQ10 hook (AD-11) — always surfaced as-is, never branched on. */
  roleTier: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Request as seen by any handler behind `AdminAuthGuard` — the already-
 * authenticated `AdminUser` (password hash never included) is attached so
 * every Epic 8/9/10 controller can read `request.user` directly instead of
 * re-deriving it from the raw JWT payload. */
export interface RequestWithAdminUser extends Request {
  user: AuthenticatedAdminUser;
}

/**
 * Story 7.1's global, reusable Admin auth guard (AD-11, AD-14) — lives in
 * `common/` (not inside the `admin-auth/` feature module) for the exact
 * same reason `guarded-update.ts`/`order-status-transition.ts` do: every
 * later Epic 8/9/10 story imports `AdminAuthGuard`/`RequestWithAdminUser`
 * straight from here (`@UseGuards(AdminAuthGuard)` on its own controller)
 * without ever having to import the `admin-auth` feature module itself.
 * That still works because Passport's strategy registry is a single
 * process-wide singleton: `AdminJwtStrategy` only needs to be instantiated
 * ONCE, as a provider of `AdminAuthModule` (imported once, in `AppModule`),
 * for the named `'admin-jwt'` strategy this guard delegates to
 * (`AuthGuard('admin-jwt')`) to be available everywhere.
 *
 * AD-14 in full: this is the *module-dependency-direction* rule (nothing
 * later in the chain gets imported by something earlier), not a ban on a
 * shared guard — the rule it actually enforces here is "one `Orders`
 * module gated at the route level", which is exactly what every future
 * consumer of this guard does: add `@UseGuards(AdminAuthGuard)` to one of
 * its own routes, never spin up a separate `AdminOrders`/`AdminCatalog`
 * module split from its public counterpart.
 *
 * **Correction (Story 8.1), one specific DI wrinkle the paragraph above
 * doesn't cover**: the *Passport strategy registry* (where `'admin-jwt'`
 * itself lives) really is process-wide and needs `AdminJwtStrategy`
 * instantiated only once, as claimed above. But `AuthGuard('admin-jwt')`
 * (the class this guard extends) ALSO has its own Nest-DI constructor
 * dependency on an `AuthModuleOptions` provider, and Nest DI providers are
 * scoped per-module — `AdminAuthModule` registering `PassportModule` for
 * itself does not make that provider reachable from a guard instantiated
 * inside a *different* module. Confirmed empirically in Story 8.1:
 * `AdminCategoriesController` (in its own `admin-catalog/` module) failed
 * to boot with `Nest can't resolve dependencies of the AdminAuthGuard
 * (?)... argument AuthModuleOptions ... is not available` until that
 * module ALSO imported `PassportModule.register({ defaultStrategy:
 * 'admin-jwt' })` itself (see `admin-catalog.module.ts`'s own doc comment
 * for the full writeup) — never `AdminAuthModule`, which would violate
 * AD-14. Every future Epic 8/9/10 module adding its own
 * `@UseGuards(AdminAuthGuard)` route needs that same one-line
 * `PassportModule.register(...)` import alongside it.
 *
 * **Why `AuthGuard('admin-jwt')` and not a hand-rolled `CanActivate`** (the
 * pattern `OrderAccessTokenGuard` uses): that guard verifies a raw opaque
 * token against a DB-stored hash it has to look up itself. This guard
 * verifies a real JWT — signature, expiry, and payload shape are exactly
 * what `passport-jwt`'s `Strategy` already implements correctly (AD-11
 * explicitly names `passport-jwt`) — re-implementing that by hand would be
 * the CWE-347 mistake this codebase should not risk. `handleRequest` is
 * overridden purely to translate Passport's default `UnauthorizedException`
 * into this codebase's own `{ statusCode, errorCode, message }` shape
 * (`ApiException`), matching every other guard/exception in this API.
 *
 * **Every failure mode collapses to the same 401**: no `Authorization`
 * header, a malformed header, an expired token, a tampered/invalid
 * signature, or a well-formed token for an `AdminUser` id that no longer
 * exists (see `AdminJwtStrategy.validate`) — `passport-jwt` itself already
 * refuses to invoke `validate()` at all for an unverifiable token, and
 * `AdminJwtStrategy.validate` throwing turns into the exact same `err`
 * branch below. There is no 403 case in this story: nothing yet
 * distinguishes "authenticated Admin" from "authenticated Admin with
 * enough permission" (that is exactly the reserved, unused `roleTier`
 * hook) — every authenticated Admin can reach any `AdminAuthGuard`-gated
 * route today.
 */
@Injectable()
export class AdminAuthGuard extends AuthGuard('admin-jwt') {
  handleRequest<TUser = AuthenticatedAdminUser>(
    err: unknown,
    user: TUser | false,
  ): TUser {
    if (err || !user) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_ADMIN_TOKEN',
        'This route requires a valid Admin session, sent as "Authorization: Bearer <token>" from POST /api/v1/admin/auth/login.',
      );
    }
    return user;
  }
}
