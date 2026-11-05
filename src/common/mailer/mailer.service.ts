import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** `c4@qa.test` -> `c***@qa.test`: the log still says which domain refused, not who. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, (m) => `${m[0]}***${m.slice(m.indexOf('@'))}`);
}

/**
 * A rejected recipient comes back from the SMTP server as `550 5.1.1 <c4@qa.test>` in the error's message,
 * `response`, `command` and `rejected` list: the redactor of the logs does not mask email addresses, so
 * the address of a customer went to the log in clear (Story 20.7 round 3). The error that leaves the mailer
 * is the same one with every address masked and without the raw `rejected`/`rejectedErrors` lists.
 */
export function sanitizeMailError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & Record<string, unknown>;
  try {
    e.message = maskEmails(e.message);
    if (typeof e.stack === 'string') e.stack = maskEmails(e.stack);
    for (const k of ['response', 'command']) {
      if (typeof e[k] === 'string') e[k] = maskEmails(e[k]);
    }
    delete e.rejected;
    delete e.rejectedErrors;
  } catch {
    /* a frozen error: leave it */
  }
  return e;
}

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
      // Story 20.6a: a server that accepts the connection and never answers must not keep a socket (and
      // the request or background job that waits for it) for nodemailer's defaults of 2 minutes (connect)
      // and 10 minutes (socket).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
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
    try {
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        text: options.text,
      });
    } catch (err) {
      throw sanitizeMailError(err);
    }
  }

  onModuleDestroy(): void {
    this.transporter?.close();
  }
}
