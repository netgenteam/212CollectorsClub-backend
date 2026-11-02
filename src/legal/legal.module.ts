import { Module } from '@nestjs/common';
import { LegalDocumentsService } from './legal-documents.service.js';
import { LegalMarkdownService } from './legal-markdown.service.js';
import { LegalPublicController } from './legal-public.controller.js';

/** Story 19.1 (AD-88..91). PrismaModule is global in the host app. */
@Module({
  controllers: [LegalPublicController],
  providers: [LegalDocumentsService, LegalMarkdownService],
  exports: [LegalDocumentsService, LegalMarkdownService],
})
export class LegalModule {}
