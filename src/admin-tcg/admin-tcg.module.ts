import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TcgModule } from '../tcg/tcg.module.js';
import { AdminTcgController } from './admin-tcg.controller.js';
import { AdminTcgService } from './admin-tcg.service.js';

/**
 * Story 15.5 (AD-56, AD-14). PassportModule import: same per-module
 * `AuthModuleOptions` reason as `AdminCatalogModule` / `AdminCustomersModule`.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    TcgModule,
  ],
  controllers: [AdminTcgController],
  providers: [AdminTcgService],
})
export class AdminTcgModule {}
