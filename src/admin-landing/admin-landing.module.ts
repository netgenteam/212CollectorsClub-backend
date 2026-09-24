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
  // two guarded admin PUTs (AdminLandingContentController) both live in
  // this one module — mirrors AdminCatalogModule's "public + admin
  // controllers, one module" shape rather than splitting into two modules
  // for a single small feature area. Stories 10.2/10.3 are expected to add
  // their own admin controllers to this same module (their own fixed key
  // sets, same shared LandingContentService/LandingConfigEntry table) —
  // see landing-content.constants.ts's doc comment.
  controllers: [AdminLandingContentController, LandingContentController],
  providers: [LandingContentService],
})
export class AdminLandingModule {}
