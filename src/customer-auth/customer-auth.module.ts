import { Module } from '@nestjs/common';
import { MailerModule } from '../common/mailer/mailer.module.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { CustomerAuthService } from './customer-auth.service.js';

/**
 * Story 12.3 (AD-28). `CUSTOMER_AUTH` comes from the @Global
 * `AuthCoreModule`; `ThrottlerGuard`'s options/storage come from the
 * `ThrottlerModule.forRoot` that `ContactModule` already registers (global).
 */
@Module({
  imports: [MailerModule],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService],
})
export class CustomerAuthModule {}
