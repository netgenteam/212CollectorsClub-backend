import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminCategoriesController } from './admin-categories.controller.js';
import { AdminCategoriesService } from './admin-categories.service.js';

// PrismaService is provided by the global PrismaModule (see
// src/prisma/prisma.module.ts) — no need to re-import it here.
//
// AdminAuthGuard (`common/admin-auth.guard.ts`) is imported directly by the
// controller, never `AdminAuthModule` itself (AD-14: this module must not
// depend on `admin-auth/`) — but `AdminAuthGuard extends AuthGuard('admin-
// jwt')`, and `@nestjs/passport`'s `AuthGuard()` mixin has its OWN
// constructor dependency on an `AuthModuleOptions` provider. That provider
// is registered by `PassportModule.register(...)`, and Nest DI providers
// are scoped per-module — `AdminAuthModule` registering `PassportModule`
// for itself does NOT make `AuthModuleOptions` available to a guard
// instantiated inside a *different* module. (The passport *strategy*
// registry — where `'admin-jwt'` itself lives — genuinely is a process-wide
// singleton per `AdminAuthGuard`'s own doc comment; only this one specific
// DI-provider dependency is not.) Confirmed empirically here: without this
// import, every route on `AdminCategoriesController` fails to boot with
// `Nest can't resolve dependencies of the AdminAuthGuard (?)... argument
// AuthModuleOptions at index [0] is not available in the AdminCatalogModule
// module`. `@nestjs/passport` itself documents the fix in its own runtime
// warning text: "ensure to import PassportModule in each place where
// AuthGuard() is being used" — this is exactly that, scoped to this module
// only (never `AdminAuthModule`), so every future Epic 8/9/10 module that
// adds its own `@UseGuards(AdminAuthGuard)` route needs this same one-line
// import.
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [AdminCategoriesController],
  providers: [AdminCategoriesService],
})
export class AdminCatalogModule {}
