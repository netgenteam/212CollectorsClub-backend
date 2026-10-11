import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminJwtStrategy } from './admin-jwt.strategy.js';

/** Story 12.2: `ADMIN_AUTH` comes from the @Global `AuthCoreModule`. */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy],
})
export class AdminAuthModule {}
