import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { VERIFICATION_PREFIX } from '../customer-auth/customer-auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { VerifyCustomerEmailResponseDto } from './dto/verify-customer-email.dto.js';

type Outcome = 'verified' | 'already_verified' | 'not_found';

/**
 * Story 13.1 (FR-53, AD-39) - TEMPORARY, remove with real SMTP.
 */
@Injectable()
export class AdminCustomersService {
  private readonly logger = new Logger(AdminCustomersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks the customer's email as verified and drops that customer's pending
   * email-verification tokens (only `email-verification:` rows whose `value`
   * is the customer id: BetterAuth reset-password rows share the table and
   * must survive). Idempotent. The same advisory lock as
   * `CustomerAuthService.issueVerificationToken` serializes concurrent calls.
   */
  async verifyEmail(
    adminId: string,
    email: string,
  ): Promise<VerifyCustomerEmailResponseDto> {
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        const customer = await tx.customer.findUnique({
          where: { email },
          select: { id: true },
        });
        if (!customer) return 'not_found';
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'verify:' + customer.id}, 0))`;
        // Re-read under the lock so a racing call reports consistently.
        const current = await tx.customer.findUnique({
          where: { id: customer.id },
          select: { emailVerified: true },
        });
        if (!current) return 'not_found';
        await tx.customerVerification.deleteMany({
          where: {
            value: customer.id,
            identifier: { startsWith: VERIFICATION_PREFIX },
          },
        });
        if (current.emailVerified) return 'already_verified';
        await tx.customer.update({
          where: { id: customer.id },
          data: { emailVerified: true },
        });
        return 'verified';
      },
    );

    this.logger.log(
      JSON.stringify({ event: 'MANUAL_EMAIL_VERIFY', adminId, email, outcome }),
    );

    if (outcome === 'not_found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CUSTOMER_NOT_FOUND',
        'No customer account exists for that email.',
      );
    }
    return { email, emailVerified: true };
  }
}
