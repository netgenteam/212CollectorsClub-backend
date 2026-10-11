import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { createAdminAuth } from './admin-auth.factory.js';
import { createCustomerAuth } from './customer-auth.factory.js';
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
  imports: [ConfigModule],
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
      inject: [PrismaService, ConfigService],
      useFactory: (prisma: PrismaService, config: ConfigService) =>
        createCustomerAuth(
          prisma,
          config.getOrThrow<string>('CUSTOMER_AUTH_SECRET'),
          {
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
