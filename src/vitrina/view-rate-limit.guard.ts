import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

export const VIEW_THROTTLED = Symbol('viewThrottled');

/**
 * Story 18.7 (AD-82): per-IP limit for `POST /products/:id/view`. When the
 * limit is exceeded it does NOT emit a 429 (that would act as an oracle /
 * noisy signal): it flags the request and lets the handler answer 204
 * without counting.
 */
@Injectable()
export class ViewRateLimitGuard extends ThrottlerGuard {
  protected override throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    (req as unknown as Record<symbol, boolean>)[VIEW_THROTTLED] = true;
    return Promise.resolve();
  }
}
