import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import { SubmitContactInquiryDto } from './dto/submit-contact-inquiry.dto.js';
import { ContactInquiryResponseDto } from './dto/contact-inquiry-response.dto.js';

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Story 6.1 (FR-18/FR-19): implements the Architecture's Contact
   * correctness rule verbatim — persist the `ContactInquiry` row first,
   * attempt the admin-notification email after, and let that email's
   * outcome (success or failure) never affect whether this method
   * succeeds. Two decisions below aren't spelled out by the story/AC and
   * are recorded here the same way prior stories record their own gap-
   * filling decisions:
   *
   * - **A `productId` that doesn't resolve to a real, current Product**
   *   (mistyped, or a real product deleted between the buyer loading the
   *   page and submitting the form) does NOT reject the submission. The
   *   FK is nullable with `onDelete: SetNull` specifically so a Product
   *   disappearing later can never retroactively orphan/lose an inquiry;
   *   the same reasoning applies going forward — the buyer's message is
   *   still worth capturing even if the product reference doesn't
   *   resolve, so it's silently stored as `null` rather than 404ing (which
   *   would also risk a raw Prisma FK-violation 500 for a caller who just
   *   has a slightly stale product page open). This mirrors the "Zero
   *   Contact Inquiries lost" success metric (PRD SM-4).
   * - **Every step after the initial `create` is wrapped so nothing it
   *   does can turn a persisted row into a failed response** — not just
   *   the email send itself, but also the follow-up `update` that records
   *   the outcome. A failure recording the outcome (e.g. a transient DB
   *   hiccup right after a successful send) is logged and swallowed the
   *   same way a send failure is; it never rethrows.
   */
  async submitInquiry(
    dto: SubmitContactInquiryDto,
  ): Promise<ContactInquiryResponseDto> {
    const productId = dto.productId
      ? await this.resolveProductId(dto.productId)
      : null;

    // Persist-first: this write is unconditional once we reach this line
    // (validation already passed via the global ValidationPipe before the
    // controller ever called this method) — nothing below it can roll it
    // back or prevent it from already being durable.
    const inquiry = await this.prisma.contactInquiry.create({
      data: {
        name: dto.name,
        email: dto.email,
        message: dto.message,
        productId,
      },
    });

    await this.attemptNotificationEmail(inquiry.id, dto);

    return { id: inquiry.id, createdAt: inquiry.createdAt };
  }

  private async resolveProductId(productId: string): Promise<string | null> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    return product?.id ?? null;
  }

  /**
   * Email is attempted and its outcome recorded, but this method itself
   * never throws — see the class doc above for why both the send and the
   * outcome-recording update are individually guarded.
   */
  private async attemptNotificationEmail(
    inquiryId: string,
    dto: SubmitContactInquiryDto,
  ): Promise<void> {
    try {
      const adminEmail = this.configService.getOrThrow<string>(
        'ADMIN_CONTACT_EMAIL',
      );
      await this.mailer.sendMail({
        to: adminEmail,
        subject: `New contact inquiry from ${dto.name}`,
        text: this.buildEmailBody(dto),
      });

      await this.prisma.contactInquiry.update({
        where: { id: inquiryId },
        data: { emailStatus: 'SENT' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Contact inquiry ${inquiryId} persisted, but the admin-notification email failed: ${message}`,
      );

      try {
        await this.prisma.contactInquiry.update({
          where: { id: inquiryId },
          data: {
            emailStatus: 'FAILED',
            emailErrorMessage: message.slice(0, 500),
          },
        });
      } catch (updateError) {
        const updateMessage =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        this.logger.error(
          `Also failed to record emailStatus=FAILED for contact inquiry ${inquiryId}: ${updateMessage}`,
        );
      }
    }
  }

  private buildEmailBody(dto: SubmitContactInquiryDto): string {
    const lines = [
      `Name: ${dto.name}`,
      `Email: ${dto.email}`,
      ...(dto.productId ? [`Product viewed: ${dto.productId}`] : []),
      '',
      dto.message,
    ];
    return lines.join('\n');
  }
}
