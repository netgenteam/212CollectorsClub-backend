import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminJwtStrategy } from './admin-jwt.strategy.js';

/**
 * Story 7.1 (AD-11, AD-14). Owns the login endpoint, the `AdminUser`
 * credential check, and registers the `'admin-jwt'` Passport strategy —
 * but NOT the reusable guard itself (`AdminAuthGuard` lives in `common/`,
 * see that file's own doc comment for why every later Epic 8/9/10 module
 * imports the guard directly instead of this whole module).
 *
 * `JwtModule.registerAsync` (not a bare `JwtModule.register`) so the
 * signing secret/options come from `ConfigService` like every other secret
 * in this codebase (`COOKIE_SECRET`, PayPal credentials, SMTP), never a
 * literal. `PassportModule.register` names `'admin-jwt'` as this module's
 * default strategy purely for conventional completeness — `AdminAuthGuard`
 * always names it explicitly (`AuthGuard('admin-jwt')`) and never relies on
 * this default.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('ADMIN_JWT_SECRET'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy],
})
export class AdminAuthModule {}
