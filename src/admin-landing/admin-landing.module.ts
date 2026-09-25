import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminLandingContentController } from './admin-landing-content.controller.js';
import { LandingContentController } from './landing-content.controller.js';
import { LandingContentService } from './landing-content.service.js';

// PrismaService is provided by the global PrismaModule (see
// src/prisma/prisma.module.ts) — no need to re-import it here.
//
// PassportModule.register({ defaultStrategy: 'admin-jwt' }) is required
// here for exactly the reason documented at length in
// admin-catalog.module.ts's own doc comment (and AdminAuthGuard's):
// `AdminAuthGuard extends AuthGuard('admin-jwt')`, whose base class has its
// own Nest-DI dependency on an `AuthModuleOptions` provider that is scoped
// per-module — `AdminAuthModule` registering `PassportModule` for itself
// does NOT make that provider reachable from a guard instantiated inside a
// different module (`AdminLandingContentController` lives here). Without
// this import, this module fails to boot with `Nest can't resolve
// dependencies of the AdminAuthGuard (?)... argument AuthModuleOptions ...
// is not available in the AdminLandingModule module` — confirmed
// empirically, same as every prior Epic 8/9/10 module.
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  // Story 10.1: the public GET (LandingContentController, no guard) and the
  // guarded admin PUTs (AdminLandingContentController) both live in this
  // one module — mirrors AdminCatalogModule's "public + admin controllers,
  // one module" shape rather than splitting into two modules for a single
  // small feature area. Story 10.2 added its "drop212" PUT as a 3rd route
  // on this SAME AdminLandingContentController (own fixed key set, own
  // section-specific ISO-8601 validation for "targetDate", same shared
  // LandingContentService/LandingConfigEntry table) rather than a new
  // controller class — no new module wiring needed. Story 10.3 added a 4th
  // route ("pack_simulator/:key") the same way — same
  // controller/service/module, zero new wiring — but with an OPEN key set
  // instead of a fixed one; see landing-content.constants.ts's doc comment
  // for why. This completes Epic 10: all three FR-29/30/31 stories share
  // one table and one controller/service pair.
  controllers: [AdminLandingContentController, LandingContentController],
  providers: [LandingContentService],
})
export class AdminLandingModule {}
