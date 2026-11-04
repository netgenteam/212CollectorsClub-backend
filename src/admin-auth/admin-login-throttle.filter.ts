import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import type { ApiErrorBody } from '../common/api-exception.js';
import { ADMIN_LOGIN_RATE_LIMITED } from './admin-login-limiter.js';

/** Window of the generic ceiling (`@Throttle` of the login route), the fallback for `Retry-After`. */
export const ADMIN_LOGIN_THROTTLE_TTL_SECONDS = 10 * 60;

/**
 * Story 20.5: the generic per-IP ceiling of the admin login (`@Throttle` 60 attempts / 10 min)
 * answered a bare `ThrottlerException` (`{statusCode, message}`, no `errorCode`). It now answers
 * exactly like the failure limits of `AdminLoginLimiter`: 429 `ADMIN_LOGIN_RATE_LIMITED`, a
 * `Retry-After` header and `details.retryAfterSeconds` (plus `details.scope: 'IP_RATE'`).
 *
 * It is a FILTER, not a guard subclass, on purpose: the route keeps the stock `ThrottlerGuard`
 * (the token the e2e suites override to switch throttling off).
 */
@Catch(ThrottlerException)
export class AdminLoginThrottleFilter implements ExceptionFilter<ThrottlerException> {
  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // `ThrottlerGuard` already set `Retry-After` (seconds until the block ends) before throwing.
    const set = Number(res.getHeader('Retry-After'));
    const seconds =
      Number.isFinite(set) && set >= 1
        ? Math.ceil(set)
        : ADMIN_LOGIN_THROTTLE_TTL_SECONDS;
    const body: ApiErrorBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      errorCode: ADMIN_LOGIN_RATE_LIMITED,
      message: 'Too many login attempts. Try again later.',
      details: { retryAfterSeconds: seconds, scope: 'IP_RATE' },
    };
    res
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .setHeader('Retry-After', String(seconds));
    res.json(body);
  }
}
