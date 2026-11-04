import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { MailerModule } from '../common/mailer/mailer.module.js';
import { AuditAdminController } from './audit-admin.controller.js';
import { AuditChainVerifier } from './audit-chain-verifier.js';
import { AuditReadService } from './audit-read.service.js';
import { AuditVerifyCron } from './audit-verify.cron.js';
import { AuditVerifyService } from './audit-verify.service.js';
import { AuditService } from './audit.service.js';

/** Story 20.1. Global so the emitters of Stories 20.4-20.8 inject `AuditService` without importing it. */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'admin-jwt' }),
    MailerModule,
  ],
  controllers: [AuditAdminController],
  providers: [
    AuditService,
    AuditChainVerifier,
    AuditReadService,
    AuditVerifyService,
    AuditVerifyCron,
  ],
  exports: [AuditService, AuditReadService, AuditVerifyService],
})
export class AuditModule {}
