import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ConsentService } from './consent.service.js';
import { LegalAdminController } from './legal-admin.controller.js';
import { LegalAuditService } from './legal-audit.service.js';
import { LegalDiffService } from './legal-diff.service.js';
import { LegalDocumentsService } from './legal-documents.service.js';
import { LegalDraftService } from './legal-draft.service.js';
import { LegalMarkdownService } from './legal-markdown.service.js';
import { MeConsentController } from './me-consent.controller.js';
import { LegalPublicController } from './legal-public.controller.js';
import { LegalPublishService } from './legal-publish.service.js';
import { SellerIdentityService } from './seller-identity.service.js';

/** Stories 19.1 (public read) and 19.2 (admin). PrismaModule is global in the host app. */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'admin-jwt' })],
  controllers: [
    LegalPublicController,
    LegalAdminController,
    MeConsentController,
  ],
  providers: [
    LegalDocumentsService,
    LegalMarkdownService,
    LegalAuditService,
    LegalDraftService,
    LegalPublishService,
    LegalDiffService,
    SellerIdentityService,
    ConsentService,
  ],
  exports: [
    LegalDocumentsService,
    LegalMarkdownService,
    LegalAuditService,
    LegalDraftService,
    LegalPublishService,
    LegalDiffService,
    SellerIdentityService,
    ConsentService,
  ],
})
export class LegalModule {}
