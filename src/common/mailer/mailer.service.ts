import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
}

/**
 * Story 6.1 (FR-18, PRD OQ9): a thin, swappable wrapper around a nodemailer
 * SMTP transport. Every connection parameter — host/port/secure/user/pass/
 * from — is read exclusively from `ConfigService` (env vars), never
 * hardcoded, per AD-15/FR-3. This is deliberate: PRD Open Question OQ9 (the
 * real production SMTP/email provider) is still unresolved — it needs
 * Nabil/Net Gen to confirm before launch — so this class's whole job is to
 * make that a config change, not a code change, whenever that answer
 * lands. Nothing above this class (ContactService) ever imports
 * `nodemailer` directly or knows it's the underlying library; swapping to
 * another transport/provider later only touches this one file.
 *
 * The `Transporter` is created once in `onModuleInit` and reused for the
 * module's lifetime (same connect-once/reuse shape as `PrismaService`),
 * rather than a fresh transport per send.
 */
@Injectable()
export class MailerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailerService.name);
  private transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const host = this.configService.getOrThrow<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    // Explicit opt-in flag rather than inferring from the port, so a
    // non-standard port (e.g. MailHog's 1025 in local dev) doesn't need to
    // "look like" 465/587 to behave correctly.
    const secure =
      this.configService.get<string>('SMTP_SECURE', 'false') === 'true';
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      // Local test SMTP servers (MailHog/maildev) accept unauthenticated
      // connections — omitting `auth` entirely (rather than sending empty
      // strings) is what lets the same code path work against both those
      // and a real provider that requires credentials once OQ9 is
      // resolved.
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
    this.logger.log(`SMTP transport configured for ${host}:${port}`);
  }

  /**
   * Sends one email via the configured transport. Deliberately does NOT
   * catch/swallow errors itself — ContactService is the one place that
   * decides what "the send failed" means for its own persist-first
   * correctness rule (catch/log/record on the row, never rethrow to the
   * caller); a generic MailerService failing loudly is the right default
   * for any other future caller (e.g. Pago Móvil instructions) that may
   * have different failure-handling needs.
   */
  async sendMail(options: SendMailOptions): Promise<void> {
    if (!this.transporter) {
      throw new Error('MailerService.sendMail called before onModuleInit');
    }
    const from = this.configService.getOrThrow<string>('SMTP_FROM');
    await this.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
    });
  }

  onModuleDestroy(): void {
    this.transporter?.close();
  }
}
