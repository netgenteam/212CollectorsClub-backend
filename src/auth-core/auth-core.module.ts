import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { createAdminAuth } from './admin-auth.factory.js';
import { createCustomerAuth } from './customer-auth.factory.js';
import { Logger } from '@nestjs/common';
import { MailerModule } from '../common/mailer/mailer.module.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import { DEFAULT_FRONTEND_URL, resetPasswordEmail } from './customer-mail.js';
import { ADMIN_AUTH, CUSTOMER_AUTH } from './auth-core.constants.js';

/**
 * Story 12.2 (AD-25): hosts the BetterAuth instances as injectable
 * providers. `ADMIN_AUTH_SECRET` is preferred; `ADMIN_JWT_SECRET` (the
 * pre-12.2 name) is accepted as a fallback so old `.env`/CI keep booting
 * (AD-32 R5). The customer instance (Story 12.3) uses its own mandatory
 * `CUSTOMER_AUTH_SECRET`, never shared with the admin one (FR-41).
 */
@Global()
@Module({
  imports: [ConfigModule, MailerModule],
  providers: [
    {
      provide: ADMIN_AUTH,
      inject: [PrismaService, ConfigService],
      useFactory: (prisma: PrismaService, config: ConfigService) => {
        const secret =
          config.get<string>('ADMIN_AUTH_SECRET') ||
          config.getOrThrow<string>('ADMIN_JWT_SECRET');
        return createAdminAuth(prisma, secret);
      },
    },
    {
      provide: CUSTOMER_AUTH,
      inject: [PrismaService, ConfigService, MailerService],
      useFactory: (
        prisma: PrismaService,
        config: ConfigService,
        mailer: MailerService,
      ) =>
        createCustomerAuth(
          prisma,
          config.getOrThrow<string>('CUSTOMER_AUTH_SECRET'),
          {
            // Fire-and-forget: the response must not depend on (nor leak
            // through its timing) whether the email exists or SMTP is slow.
            sendResetPassword: (user, token) => {
              const frontendUrl = config.get<string>(
                'FRONTEND_URL',
                DEFAULT_FRONTEND_URL,
              );
              mailer
                .sendMail(
                  resetPasswordEmail(user.email, user.name, frontendUrl, token),
                )
                .catch((err: unknown) =>
                  new Logger('CustomerMail').error(
                    `Reset-password email failed: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
            },
            secureCookies:
              config.get<string>('NODE_ENV', 'development') !== 'development' &&
              config.get<string>('NODE_ENV', 'development') !== 'test',
          },
        ),
    },
  ],
  exports: [ADMIN_AUTH, CUSTOMER_AUTH],
})
export class AuthCoreModule {}
