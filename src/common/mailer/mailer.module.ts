import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service.js';

/**
 * Story 6.1: standalone (not global) so only modules that actually send
 * email import it explicitly — today just `ContactModule`, but the PRD
 * names a second future consumer (Pago Móvil payment instructions, Epic 4)
 * that would import this same module rather than duplicating a transport.
 */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
