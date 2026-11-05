import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { redactText } from '../audit/audit-payload.js';
import { REQUEST_ID_HEADER } from '../common/request-id.middleware.js';
import { redactString } from '../common/redact.js';
import { isExcludedRequest, normalizeRoute } from './route-normalize.js';
import type { UsageLogBuffer } from './usage-log.buffer.js';
import type { UsageLogRow } from './usage-log.types.js';

export const USER_AGENT_MAX = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u2028\u2029]`,
  'g',
);
const METHOD_RE = /^[A-Z]{1,10}$/;

/** A valid IPv4/IPv6 text (no zone id), or null: a malformed value must never poison a batch of 200. */
export function cleanIp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    return null;
  }
  const noZone = raw.replace(/%.*$/, '');
  return isIP(noZone) !== 0 ? noZone : null;
}

/**
 * The user agent as stored: control characters gone, cut to 200 CODE POINTS (a cut inside a surrogate
 * pair would be an invalid string), then any cedula, email, phone, card or secret in it masked (a
 * crawler's `User-Agent` often carries a contact address). `null` when nothing is left.
 */
export function cleanUserAgent(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const head = raw.length > 600 ? raw.slice(0, 600) : raw;
  let s = Array.from(head.replace(CONTROL, ' '))
    .slice(0, USER_AGENT_MAX)
    .join('')
    .trim();
  if (s.length === 0) return null;
  s = redactString(redactText(s).text);
  return Array.from(s).slice(0, USER_AGENT_MAX).join('') || null;
}

const idOf = (v: unknown): string | null => {
  const id = (v as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
};

type ReqLike = Request & {
  user?: unknown;
  customer?: unknown;
};

/**
 * Builds the row for a finished request, or `null` when it is not recorded. Reads ONLY: method, the
 * matched route template, the status, the duration, `req.ip`, the `User-Agent` header, the request id
 * header the response already carries and the ids set by the guards. Never a body, never `Authorization`
 * or `Cookie`, never `originalUrl`/`url`/`query` (except to decide an exclusion, see `isExcludedRequest`).
 */
export function buildUsageRow(
  req: ReqLike,
  res: Pick<Response, 'statusCode' | 'getHeader'>,
  startNs: bigint,
  now: number = Date.now(),
): UsageLogRow | null {
  if (isExcludedRequest(req, req.originalUrl ?? '')) return null;
  const admin = idOf(req.user);
  const customer = admin === null ? idOf(req.customer) : null;
  const rid = res.getHeader(REQUEST_ID_HEADER);
  const requestId =
    typeof rid === 'string' && UUID_RE.test(rid) ? rid : randomUUID();
  const status = res.statusCode;
  return {
    ts: now,
    method: METHOD_RE.test(req.method) ? req.method : 'OTHER',
    route: normalizeRoute(req),
    status:
      Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
    durationMs: Math.max(
      0,
      Math.min(
        2_147_483_647,
        Math.round(Number(process.hrtime.bigint() - startNs) / 1e6),
      ),
    ),
    actorType:
      admin !== null ? 'ADMIN' : customer !== null ? 'CUSTOMER' : 'ANON',
    actorId: admin ?? customer,
    ip: cleanIp(req.ip),
    userAgent: cleanUserAgent(req.headers['user-agent']),
    requestId,
  };
}

/**
 * Story 20.7 (AD-100, AC2): a plain Express middleware, NOT a Nest interceptor (an interceptor does not
 * see a 404 nor a request a guard rejected). Mounted before `cookie-parser`. On `finish` it queues one
 * row; that is all it does, synchronously and without I/O. Anything that goes wrong inside it is
 * swallowed: the request is already answered. A connection that closes before the response is finished
 * (`close` without `finish`) is not recorded: there is no status to record.
 */
export function createUsageLogMiddleware(
  buffer: UsageLogBuffer,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();
    res.once('finish', () => {
      try {
        const row = buildUsageRow(req, res, startNs);
        if (row !== null) buffer.push(row);
      } catch {
        /* never reaches the client */
      }
    });
    next();
  };
}

/** `main.ts` mounts it right after the request-id middleware and before `cookie-parser`; e2e apps that want it call it too. */
export function applyUsageLog(
  app: NestExpressApplication,
  buffer: UsageLogBuffer,
): boolean {
  if (!buffer.enabled) return false;
  app.use(createUsageLogMiddleware(buffer));
  return true;
}
