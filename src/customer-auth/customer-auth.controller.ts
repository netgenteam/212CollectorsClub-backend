import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { CUSTOMER_SESSION_COOKIE } from '../auth-core/customer-auth.factory.js';
import {
  CustomerAuthGuard,
  type RequestWithCustomer,
} from '../common/customer-auth.guard.js';
import { CustomerAuthService } from './customer-auth.service.js';
import {
  CustomerResponseDto,
  MessageResponseDto,
  RegisterCustomerResponseDto,
} from './dto/customer-response.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginCustomerDto } from './dto/login-customer.dto.js';
import { RegisterCustomerDto } from './dto/register-customer.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { strictBody } from './strict-body.pipe.js';

// Same per-IP mechanism and budget as POST /contact (Story 6.1).
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const THROTTLE = {
  default: { limit: RATE_LIMIT_MAX_REQUESTS, ttl: RATE_LIMIT_WINDOW_MS },
};

/**
 * Story 12.3 (FR-42, AD-28). Body params are typed `Readonly<Dto>` on
 * purpose: see `strictBody` (unknown fields must 400, not be stripped).
 */
@ApiTags('customer-auth')
@Controller('auth')
export class CustomerAuthController {
  constructor(private readonly service: CustomerAuthService) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle(THROTTLE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a customer account',
    description:
      'Creates the account (Argon2id) and NEVER signs in. The response is identical whether the email was new or already registered (anti-enumeration). Rate-limited to 5 per IP per 10 minutes.',
  })
  @ApiBody({ type: RegisterCustomerDto })
  @ApiResponse({ status: 201, type: RegisterCustomerResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid email, password < 8 chars, empty name or unknown field.',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async register(
    @Body(strictBody(RegisterCustomerDto)) dto: Readonly<RegisterCustomerDto>,
  ): Promise<RegisterCustomerResponseDto> {
    await this.service.register(dto);
    return {
      message:
        'If this email can be registered, the account has been created. You can now log in.',
    };
  }

  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle(THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Customer login',
    description:
      'Verifies email + password and sets the httpOnly cookie `cc_session` (7 days, 1-day sliding, sameSite=lax, secure outside dev). No token in the body. Unverified emails may log in. Rate-limited to 5 per IP per 10 minutes.',
  })
  @ApiBody({ type: LoginCustomerDto })
  @ApiResponse({ status: 200, type: CustomerResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'errorCode INVALID_CUSTOMER_CREDENTIALS - wrong password or unknown email (identical).',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async login(
    @Body(strictBody(LoginCustomerDto)) dto: Readonly<LoginCustomerDto>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerResponseDto> {
    const { customer, setCookies } = await this.service.login(
      dto.email,
      dto.password,
    );
    for (const cookie of setCookies) {
      res.append('Set-Cookie', cookie);
    }
    return customer;
  }

  @Post('verify-email')
  @UseGuards(ThrottlerGuard)
  @Throttle(THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the email with the token from the email link',
    description:
      'One-time token (24 h). Sets emailVerified=true. Rate-limited like login.',
  })
  @ApiBody({ type: VerifyEmailDto })
  @ApiResponse({ status: 200, type: MessageResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'errorCode INVALID_VERIFICATION_TOKEN - unknown, tampered, expired or already used token (uniform).',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async verifyEmail(
    @Body(strictBody(VerifyEmailDto)) dto: Readonly<VerifyEmailDto>,
  ): Promise<MessageResponseDto> {
    await this.service.verifyEmail(dto.token);
    return { message: 'Email verified.' };
  }

  @Post('forgot-password')
  @UseGuards(ThrottlerGuard)
  @Throttle(THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset email',
    description:
      'Always 200 with the same body, whether or not the email has an account (anti-enumeration); only an existing account gets the email with a one-hour one-time link. Rate-limited like login.',
  })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid email or unknown field.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async forgotPassword(
    @Body(strictBody(ForgotPasswordDto)) dto: Readonly<ForgotPasswordDto>,
  ): Promise<MessageResponseDto> {
    await this.service.forgotPassword(dto.email);
    return {
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };
  }

  @Post('reset-password')
  @UseGuards(ThrottlerGuard)
  @Throttle(THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with the reset token',
    description:
      'One-time token valid for 1 hour. Changes the password (Argon2id) and revokes ALL the customer sessions. A too-short password is a 400 and does not consume the token. Rate-limited like login.',
  })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, type: MessageResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'errorCode INVALID_RESET_TOKEN (unknown, expired or used token), or a validation error (password < 8 chars).',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async resetPassword(
    @Body(strictBody(ResetPasswordDto)) dto: Readonly<ResetPasswordDto>,
  ): Promise<MessageResponseDto> {
    await this.service.resetPassword(dto.token, dto.password);
    return { message: 'Password updated. You can now log in.' };
  }

  @Get('me')
  @UseGuards(CustomerAuthGuard)
  @ApiCookieAuth('customer-session')
  @ApiOperation({ summary: 'Get the authenticated customer' })
  @ApiResponse({ status: 200, type: CustomerResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'errorCode INVALID_CUSTOMER_TOKEN - missing, invalid, expired or revoked session.',
  })
  me(@Req() req: RequestWithCustomer): CustomerResponseDto {
    return req.customer as CustomerResponseDto;
  }

  @Patch('me')
  @UseGuards(CustomerAuthGuard)
  @ApiCookieAuth('customer-session')
  @ApiOperation({
    summary: 'Update the customer profile',
    description:
      'Only `name` and `phone` can change. Any other field (email, emailVerified, role, id, ...) is a 400.',
  })
  @ApiBody({ type: UpdateCustomerProfileDto })
  @ApiResponse({ status: 200, type: CustomerResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or unknown field.' })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  updateMe(
    @Req() req: RequestWithCustomer,
    @Body(strictBody(UpdateCustomerProfileDto))
    dto: Readonly<UpdateCustomerProfileDto>,
  ): Promise<CustomerResponseDto> {
    return this.service.updateProfile(
      (req.customer as CustomerResponseDto).id,
      dto,
    );
  }

  @Post('logout')
  @UseGuards(CustomerAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('customer-session')
  @ApiOperation({
    summary: 'Log out',
    description:
      'Deletes the session row and clears the `cc_session` cookie. The old cookie gets 401 afterwards.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  async logout(
    @Req() req: RequestWithCustomer,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.service.logout(req.customerSessionToken as string);
    res.clearCookie(CUSTOMER_SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
}
