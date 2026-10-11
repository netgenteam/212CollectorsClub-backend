import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CustomerAuth } from '../auth-core/customer-auth.factory.js';
import { CUSTOMER_AUTH } from '../auth-core/auth-core.constants.js';
import { ApiException } from './api-exception.js';

/**
 * Story 12.3 (AD-26/AD-28): the only shape a customer is ever allowed to
 * take on a request or in a response. Hand-typed (not the Prisma model) so
 * no hash/token field can be typed onto it.
 */
export interface AuthenticatedCustomer {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  emailVerified: boolean;
}

export interface RequestWithCustomer extends Request {
  customer?: AuthenticatedCustomer;
  /** Token of the live session (needed by logout). */
  customerSessionToken?: string;
}

export function invalidCustomerTokenException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CUSTOMER_TOKEN',
    'This route requires a valid customer session (cookie "cc_session" set by POST /api/v1/auth/login).',
  );
}

/**
 * Resolves the customer session behind the request cookie, or null. Only the
 * `Cookie` header is forwarded to BetterAuth: an `Authorization` header (the
 * admin token, or the guest `orderAccessToken`) can never authenticate a
 * customer, and the customer instance has no `bearer` plugin anyway.
 * When BetterAuth slides the session (older than 1 day) its refreshed
 * `Set-Cookie` is forwarded so the browser cookie lifetime follows the DB.
 */
export async function resolveCustomer(
  auth: CustomerAuth,
  request: RequestWithCustomer,
  response: Response,
): Promise<boolean> {
  const cookie = request.headers.cookie;
  if (!cookie) {
    return false;
  }
  try {
    const { headers, response: session } = await auth.api.getSession({
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    if (!session) {
      return false;
    }
    const user = session.user as typeof session.user & {
      phone?: string | null;
    };
    request.customer = {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone ?? null,
      emailVerified: user.emailVerified,
    };
    request.customerSessionToken = session.session.token;
    for (const setCookie of headers.getSetCookie()) {
      response.append('Set-Cookie', setCookie);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand-rolled `CanActivate` (AD-28, no Passport): any missing, forged,
 * expired or revoked session is a uniform 401 `INVALID_CUSTOMER_TOKEN`.
 * Lives in `common/` so later stories import it directly.
 */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(@Inject(CUSTOMER_AUTH) private readonly auth: CustomerAuth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const ok = await resolveCustomer(
      this.auth,
      http.getRequest<RequestWithCustomer>(),
      http.getResponse<Response>(),
    );
    if (!ok) {
      throw invalidCustomerTokenException();
    }
    return true;
  }
}

/**
 * For cart/wishlist/checkout from Story 12.5: attaches `request.customer`
 * when a valid session exists, otherwise lets the request through as a
 * guest. Never errors.
 */
@Injectable()
export class OptionalCustomerGuard implements CanActivate {
  constructor(@Inject(CUSTOMER_AUTH) private readonly auth: CustomerAuth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    await resolveCustomer(
      this.auth,
      http.getRequest<RequestWithCustomer>(),
      http.getResponse<Response>(),
    );
    return true;
  }
}

/** `@OptionalCustomer()`: the customer behind `OptionalCustomerGuard`, or null. */
export const OptionalCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedCustomer | null =>
    ctx.switchToHttp().getRequest<RequestWithCustomer>().customer ?? null,
);
