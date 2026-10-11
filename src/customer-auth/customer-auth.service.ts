import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import { CUSTOMER_AUTH } from '../auth-core/auth-core.constants.js';
import type { CustomerAuth } from '../auth-core/customer-auth.factory.js';
import { ApiException } from '../common/api-exception.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
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

/**
 * Story 12.3 (AD-26/AD-28, FR-42): facade over the BetterAuth customer
 * instance. BetterAuth is used through its standard `auth.api.*`; only
 * the error mapping and the anti-enumeration padding are ours.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CUSTOMER_AUTH) private readonly customerAuth: CustomerAuth,
  ) {}

  /**
   * Anti-enumeration: a new and an already-registered email yield the very
   * same (void) outcome. BetterAuth rejects the duplicate BEFORE hashing, so
   * that branch pays a dummy Argon2id hash to match the cost of the new
   * account branch. No session is ever created (`autoSignIn:false`).
   * (The "you already have an account" email arrives with Story 12.4.)
   */
  async register(dto: RegisterCustomerDto): Promise<void> {
    try {
      await this.customerAuth.api.signUpEmail({
        body: { email: dto.email, password: dto.password, name: dto.name },
      });
    } catch (err) {
      if (!(await this.isDuplicateRegistration(err, dto.email))) {
        throw err;
      }
      await argon2.hash(dto.password, { type: argon2.argon2id });
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
