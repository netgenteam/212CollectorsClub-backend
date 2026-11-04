import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Story 20.1 (AD-100): generates a UUID v4 per request, IGNORING any
 * `X-Request-Id` the client sends (an attacker could otherwise forge or
 * collide ids in the audit log), returns it in the `X-Request-Id` response
 * header (also on errors: it is set before the handler runs) and opens the
 * `RequestContext` for the rest of the request. `ip` is `req.ip`, which is the
 * client address (`trust proxy`, see `common/trust-proxy.ts`).
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  RequestContext.run({ requestId, ip: req.ip ?? null }, next);
}

/** Mounted in `main.ts` BEFORE `cookie-parser`; e2e apps call it too (they do not run main.ts). */
export function applyRequestContext(app: NestExpressApplication): void {
  app.use(requestIdMiddleware);
}
