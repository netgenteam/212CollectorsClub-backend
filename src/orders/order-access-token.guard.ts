import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import type { Order } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import {
  hashOrderAccessToken,
  timingSafeEqualHex,
} from '../common/order-access-token.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Request as seen by any handler behind `OrderAccessTokenGuard` — the
 * already-loaded, already-authorized Order is attached so the controller/
 * service never has to re-query it (and can never accidentally load a
 * DIFFERENT Order than the one the token was just checked against). */
export interface RequestWithOrder extends Request {
  order: Order;
}

const BEARER_PREFIX = /^Bearer (.+)$/;

function extractBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = BEARER_PREFIX.exec(authorizationHeader);
  return match ? match[1].trim() || null : null;
}

function missingTokenException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'MISSING_ORDER_ACCESS_TOKEN',
    'This route requires the orderAccessToken issued in the checkout response, sent as "Authorization: Bearer <token>".',
  );
}

function invalidTokenException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_ORDER_ACCESS_TOKEN',
    'The provided orderAccessToken is missing, incorrect, or does not belong to this Order.',
  );
}

/**
 * Story 4.2 (AD-17): gates every buyer-initiated route under
 * `orders/:orderId/...` that Story 4.1's checkout response's one-time
 * `orderAccessToken` is meant to authorize (Proof-of-Payment upload here;
 * a future order-status lookup, Story 5.1, the same way) — never the AD-5
 * cart cookie, never Admin auth.
 *
 * **Where the token travels**: `Authorization: Bearer <token>` header.
 * Chosen over a body/query field because this is exactly RFC 6750's shape
 * — a single-use opaque bearer credential presented on every request to a
 * specific resource — and it keeps the token out of server/proxy access
 * logs and browser history the way a query param would not, and out of
 * the multipart body the way a form field would (simpler for the
 * `POST .../proof-of-payment` multipart request specifically: the token
 * is a pure auth concern, not part of the uploaded payload).
 *
 * **401 vs 403, and why both "missing" and "wrong/other-Order" collapse to
 * the same 401 `INVALID_ORDER_ACCESS_TOKEN` outcome**: this endpoint has no
 * notion of "authenticated but insufficient permission" (403's actual
 * meaning) — the token itself IS the sole credential, so per RFC 6750 both
 * "no credential presented" and "credential presented but invalid" are 401
 * Unauthorized. A wrong token and a token that is valid for a *different*
 * Order are deliberately given the exact same response (same status, same
 * errorCode, same generic message) as each other and as "this orderId
 * doesn't exist at all" — never a distinguishing 404 for a bad orderId —
 * so a caller can never use this endpoint's response to enumerate which
 * Order IDs exist or fish for which token belongs to which order.
 *
 * **Timing-safe comparison**: the candidate token is hashed with the exact
 * same algorithm `CheckoutService` used to produce `accessTokenHash`
 * (`hashOrderAccessToken`, `common/order-access-token.ts`) and compared
 * with `crypto.timingSafeEqual` (`timingSafeEqualHex`), never `===` on
 * strings — a plain string comparison would leak how many leading bytes of
 * the hash matched through response-time variance.
 */
@Injectable()
export class OrderAccessTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithOrder>();
    // Express 5's `ParamsDictionary` types a param value as `string |
    // string[]` (repeated route segments) — this route has exactly one
    // `:orderId` segment, so a real request always yields a single string;
    // the array case (impossible via this route's definition, kept only
    // so a mismatched type can never slip through as a truthy non-UUID
    // string) is treated the same as "missing".
    const orderIdParam = request.params.orderId;
    const orderId = Array.isArray(orderIdParam) ? undefined : orderIdParam;
    const rawToken = extractBearerToken(request.headers.authorization);

    if (!rawToken) {
      throw missingTokenException();
    }
    if (!orderId || !isUUID(orderId)) {
      // A syntactically invalid orderId can never match any Order — treat
      // it exactly like "wrong token", not a separate 400/404, per the
      // no-enumeration reasoning above.
      throw invalidTokenException();
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw invalidTokenException();
    }

    const candidateHash = hashOrderAccessToken(rawToken);
    if (!timingSafeEqualHex(candidateHash, order.accessTokenHash)) {
      throw invalidTokenException();
    }

    request.order = order;
    return true;
  }
}
