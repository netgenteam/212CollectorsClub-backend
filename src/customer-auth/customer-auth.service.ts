import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import { CUSTOMER_AUTH } from '../auth-core/auth-core.constants.js';
import type { CustomerAuth } from '../auth-core/customer-auth.factory.js';
import { ApiException } from '../common/api-exception.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
import {
  alreadyRegisteredEmail,
  DEFAULT_FRONTEND_URL,
  verificationEmail,
} from '../auth-core/customer-mail.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import type { SendMailOptions } from '../common/mailer/mailer.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CustomerResponseDto } from './dto/customer-response.dto.js';
import type { RegisterCustomerDto } from './dto/register-customer.dto.js';
import type { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto.js';

const PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  emailVerified: true,
} as const;

function invalidCredentialsException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CUSTOMER_CREDENTIALS',
    'Incorrect email or password.',
  );
}

const VERIFICATION_PREFIX = 'email-verification:';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

function invalidVerificationTokenException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'INVALID_VERIFICATION_TOKEN',
    'The verification link is invalid, expired or already used.',
  );
}

function invalidResetTokenException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'INVALID_RESET_TOKEN',
    'The reset link is invalid, expired or already used.',
  );
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Story 12.3 (AD-26/AD-28, FR-42): facade over the BetterAuth customer
 * instance. BetterAuth is used through its standard `auth.api.*`; only
 * the error mapping and the anti-enumeration padding are ours.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CUSTOMER_AUTH) private readonly customerAuth: CustomerAuth,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', DEFAULT_FRONTEND_URL);
  }

  /**
   * Best-effort and NOT awaited: delivery (or its failure) never alters an
   * HTTP response nor its timing (anti-enumeration, AC1).
   */
  private sendBestEffort(mail: SendMailOptions): void {
    this.mailer.sendMail(mail).catch((err: unknown) => {
      this.logger.error(
        `Customer email "${mail.subject}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Anti-enumeration: a new and an already-registered email yield the very
   * same (void) outcome. BetterAuth rejects the duplicate BEFORE hashing, so
   * that branch pays a dummy Argon2id hash to match the cost of the new
   * account branch. No session is ever created (`autoSignIn:false`).
   * The new owner gets a verification email; the existing owner gets an
   * "you already have an account" email (Story 12.4), both best-effort.
   */
  async register(dto: RegisterCustomerDto): Promise<void> {
    let created;
    try {
      created = await this.customerAuth.api.signUpEmail({
        body: { email: dto.email, password: dto.password, name: dto.name },
      });
    } catch (err) {
      if (!(await this.isDuplicateRegistration(err, dto.email))) {
        throw err;
      }
      await argon2.hash(dto.password, { type: argon2.argon2id });
      this.sendBestEffort(alreadyRegisteredEmail(dto.email, this.frontendUrl));
      return;
    }
    // BetterAuth answers a duplicate email with a SYNTHETIC success (a fake
    // user that was never stored) after paying the hash cost. A real new
    // account exists in the DB; the fake one does not.
    const isNew =
      (await this.prisma.customer.count({ where: { id: created.user.id } })) >
      0;
    if (!isNew) {
      this.sendBestEffort(alreadyRegisteredEmail(dto.email, this.frontendUrl));
      return;
    }
    // Account committed: a failure here must not alter the 201 (AC1).
    try {
      const token = await this.issueVerificationToken(created.user.id);
      this.sendBestEffort(
        verificationEmail(dto.email, dto.name, this.frontendUrl, token),
      );
    } catch (err) {
      this.logger.error(
        `Verification token for new customer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * One-time token: only its SHA-256 is stored (a DB leak yields no usable
   * link). Row lives in `Customer_Verifications`; consuming deletes it.
   */
  private async issueVerificationToken(customerId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.customerVerification.create({
      data: {
        identifier: VERIFICATION_PREFIX + sha256(token),
        value: customerId,
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
      },
    });
    return token;
  }

  /** Uniform 400 INVALID_VERIFICATION_TOKEN for unknown/used/expired/tampered. */
  async verifyEmail(token: string): Promise<void> {
    const identifier = VERIFICATION_PREFIX + sha256(token);
    const row = await this.prisma.customerVerification.findFirst({
      where: { identifier },
    });
    if (!row) {
      throw invalidVerificationTokenException();
    }
    // Atomic consume: of two concurrent uses only one deletes the row.
    const consumed = await this.prisma.customerVerification.deleteMany({
      where: { id: row.id },
    });
    if (consumed.count !== 1 || row.expiresAt.getTime() <= Date.now()) {
      throw invalidVerificationTokenException();
    }
    await this.prisma.customer.updateMany({
      where: { id: row.value },
      data: { emailVerified: true },
    });
  }

  /**
   * Always resolves the same way. Only an existing account triggers the
   * (non-awaited) reset email through BetterAuth's one-time token.
   */
  async forgotPassword(email: string): Promise<void> {
    const exists = await this.prisma.customer.count({ where: { email } });
    if (exists === 0) {
      return;
    }
    try {
      await this.customerAuth.api.requestPasswordReset({ body: { email } });
    } catch (err) {
      this.logger.error(
        `Password reset request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** BetterAuth deletes the token, hashes (Argon2id) and revokes all sessions. */
  async resetPassword(token: string, password: string): Promise<void> {
    try {
      await this.customerAuth.api.resetPassword({
        body: { token, newPassword: password },
      });
    } catch (err) {
      if (err instanceof APIError) {
        throw invalidResetTokenException();
      }
      throw err;
    }
  }

  /**
   * True when `err` means "this email is already registered": BetterAuth's
   * own pre-check, or the loser of a concurrent registration of the same
   * email (BetterAuth reports the unique-index hit as
   * FAILED_TO_CREATE_USER; a raw P2002 is also accepted). The race cases are
   * only trusted if the customer row really exists.
   */
  private async isDuplicateRegistration(
    err: unknown,
    email: string,
  ): Promise<boolean> {
    const code = err instanceof APIError ? String(err.body?.code ?? '') : '';
    if (code.startsWith('USER_ALREADY_EXISTS')) {
      return true;
    }
    // Duck-typed: BetterAuth's adapter throws errors from its own copy of
    // @prisma/client, so `instanceof` against our generated client fails.
    const raw =
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2002';
    if (code === 'FAILED_TO_CREATE_USER' || raw) {
      return (await this.prisma.customer.count({ where: { email } })) > 0;
    }
    return false;
  }

  /**
   * Returns the profile and BetterAuth's `Set-Cookie` values (the signed
   * `cc_session`). Unknown email and wrong password are the same 401;
   * BetterAuth itself runs a full password hash for an unknown email, so
   * both branches cost one Argon2id operation.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ customer: CustomerResponseDto; setCookies: string[] }> {
    let result;
    try {
      result = await this.customerAuth.api.signInEmail({
        body: { email, password },
        returnHeaders: true,
      });
    } catch (err) {
      if (err instanceof APIError) {
        throw invalidCredentialsException();
      }
      throw err;
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: result.response.user.id },
      select: PROFILE_SELECT,
    });
    if (!customer) {
      throw invalidCredentialsException();
    }
    return { customer, setCookies: result.headers.getSetCookie() };
  }

  async updateProfile(
    customerId: string,
    dto: UpdateCustomerProfileDto,
  ): Promise<CustomerResponseDto> {
    try {
      return await this.prisma.customer.update({
        where: { id: customerId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        },
        select: PROFILE_SELECT,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw invalidCustomerTokenException();
      }
      throw err;
    }
  }

  /** Idempotent: a concurrent logout that already removed the row is fine. */
  async logout(sessionToken: string): Promise<void> {
    await this.prisma.customerSession.deleteMany({
      where: { token: sessionToken },
    });
  }
}
