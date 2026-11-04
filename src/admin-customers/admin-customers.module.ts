import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminOrdersService } from '../orders/admin-orders.service.js';
import { AdminCustomerAccountsController } from './admin-customer-accounts.controller.js';
import { AdminCustomersController } from './admin-customers.controller.js';
import { AdminCustomersService } from './admin-customers.service.js';
import { CustomerAnonymizationService } from './customer-anonymization.service.js';
import { CustomerDirectoryService } from './customer-directory.service.js';
import { ManualEmailVerifyEnabledGuard } from './manual-email-verify-enabled.guard.js';

/**
 * Story 13.1 (FR-53, AD-39): `AdminCustomersController` (verify-email) is TEMPORARY, remove with real
 * SMTP. Story 20.6: `AdminCustomerAccountsController` (list, search, detail, anonymize) is permanent.
 * PassportModule import: same per-module `AuthModuleOptions` reason as
 * `AdminCatalogModule` / `AdminLandingModule`. `AdminOrdersService` is provided here (it needs only
 * the global Prisma and crypto) to reuse its `idDocBlindOrThrow` rule for the cedula search.
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [AdminCustomersController, AdminCustomerAccountsController],
  providers: [
    AdminCustomersService,
    ManualEmailVerifyEnabledGuard,
    CustomerAnonymizationService,
    CustomerDirectoryService,
    AdminOrdersService,
  ],
})
export class AdminCustomersModule {}
