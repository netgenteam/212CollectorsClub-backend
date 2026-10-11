import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { createAdminAuth } from './admin-auth.factory.js';
import { ADMIN_AUTH } from './auth-core.constants.js';

/**
 * Story 12.2 (AD-25): hosts the BetterAuth instances as injectable
 * providers. `ADMIN_AUTH_SECRET` is preferred; `ADMIN_JWT_SECRET` (the
 * pre-12.2 name) is accepted as a fallback so old `.env`/CI keep booting
 * (AD-32 R5). The customer instance arrives in Story 12.3.
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
  ],
  exports: [ADMIN_AUTH],
})
export class AuthCoreModule {}
