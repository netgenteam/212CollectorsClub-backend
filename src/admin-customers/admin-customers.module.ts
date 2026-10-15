import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminCustomersController } from './admin-customers.controller.js';
import { AdminCustomersService } from './admin-customers.service.js';
import { ManualEmailVerifyEnabledGuard } from './manual-email-verify-enabled.guard.js';

/**
 * Story 13.1 (FR-53, AD-39) - TEMPORARY, remove with real SMTP.
 * PassportModule import: same per-module `AuthModuleOptions` reason as
 * `AdminCatalogModule` / `AdminLandingModule`.
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [AdminCustomersController],
  providers: [AdminCustomersService, ManualEmailVerifyEnabledGuard],
})
export class AdminCustomersModule {}
