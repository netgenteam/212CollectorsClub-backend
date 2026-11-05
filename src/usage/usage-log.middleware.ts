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
/** Status recorded for a request whose connection closed before the response finished. */
export const CLIENT_CLOSED_REQUEST = 499;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u2028\u2029]`,
  'g',
);
/** A UTF-16 surrogate with no partner (an invalid string: PostgreSQL's jsonb refuses the escape). */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const METHOD_RE = /^[A-Z]{1,10}$/;

/** A valid IPv4/IPv6 text (no zone id), or null: a malformed value must never poison a batch of 200. */
export function cleanIp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    return null;
  }
  // `net.isIP` is a regular expression of several hundred characters for IPv6; the same few addresses make
  // most of the requests, so the verdict is remembered (a bounded Map: a scan from many addresses only
  // turns it over).
  const hit = IP_CACHE.get(raw);
  if (hit !== undefined) return hit;
  const pct = raw.indexOf('%');
  const noZone = pct >= 0 ? raw.slice(0, pct) : raw;
  const out = isIP(noZone) !== 0 ? noZone : null;
  if (IP_CACHE.size >= IP_CACHE_SIZE) {
    const first = IP_CACHE.keys().next().value;
    if (first !== undefined) IP_CACHE.delete(first);
  }
  IP_CACHE.set(raw, out);
  return out;
}

const IP_CACHE_SIZE = 1_024;
const IP_CACHE = new Map<string, string | null>();

/**
 * The user agent as stored: control characters gone, cut to 200 CODE POINTS (a cut inside a surrogate
 * pair would be an invalid string), then any cedula, email, phone, card or secret in it masked (a
 * crawler's `User-Agent` often carries a contact address). `null` when nothing is left.
 */
export function cleanUserAgent(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // The same few hundred browsers make nearly every request: the redaction (a dozen regular expressions
  // over up to 600 characters) ran on every one of them and was the largest cost of the middleware.
  // Raw strings longer than 600 characters are not cached (a hostile client could fill the cache).
  const cacheable = raw.length <= UA_CACHE_MAX_RAW;
  if (cacheable) {
    const hit = UA_CACHE.get(raw);
    if (hit !== undefined) return hit;
  }
  const cleaned = cleanUserAgentUncached(raw);
  if (cacheable) {
    if (UA_CACHE.size >= UA_CACHE_SIZE) {
      // the oldest entry (Map keeps insertion order)
      const first = UA_CACHE.keys().next().value;
      if (first !== undefined) UA_CACHE.delete(first);
    }
    UA_CACHE.set(raw, cleaned);
  }
  return cleaned;
}

const UA_CACHE_SIZE = 512;
const UA_CACHE_MAX_RAW = 600;
const UA_CACHE = new Map<string, string | null>();

function cleanUserAgentUncached(raw: string): string | null {
  const head = raw.length > 600 ? raw.slice(0, 600) : raw;
  let s = Array.from(head.replace(CONTROL, ' '))
    .slice(0, USER_AGENT_MAX)
    .join('')
    .trim();
  if (s.length === 0) return null;
  s = redactString(redactText(s).text);
  // a lone surrogate (a cut inside a pair that the client itself sent) would be an invalid jsonb escape
  // for the whole batch of 200: U+FFFD instead
  return (
    Array.from(s)
      .slice(0, USER_AGENT_MAX)
      .join('')
      .replace(LONE_SURROGATE, '\ufffd') || null
  );
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
  aborted = false,
): UsageLogRow | null {
  if (isExcludedRequest(req, req.originalUrl ?? '')) return null;
  const admin = idOf(req.user);
  const customer = admin === null ? idOf(req.customer) : null;
  const rid = res.getHeader(REQUEST_ID_HEADER);
  const requestId =
    typeof rid === 'string' && UUID_RE.test(rid) ? rid : randomUUID();
  // A request the client cut before the response finished has no status of its own: 499 (nginx's
  // "client closed request"; Express never answers it). The handler may still have run, so the route is
  // the matched template when the router got that far and `__unmatched__` when it did not (still reading
  // the body, still in a guard): that combination is told apart from a real 404 by the status.
  const status = aborted ? CLIENT_CLOSED_REQUEST : res.statusCode;
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
 * see a 404 nor a request a guard rejected). Mounted before `cookie-parser`. It queues ONE row per request
 * and nothing else, synchronously and without I/O; anything that goes wrong inside it is swallowed (the
 * request is already answered).
 *
 * Story 20.7 round 2 (FR-133, A96): the row is written on `finish` OR on `close` without `finish`. A
 * client that cuts the connection (a closed tab, a mobile network, a `curl` killed) never triggers
 * `finish`, yet Node keeps running the handler: a real logout and ten `POST /cart/items` that were
 * aborted left no row. `close` fires once per response (also with keep-alive: it is the RESPONSE's, not the
 * socket's), `finish` fires before it on a normal one, and a flag makes the second event a no-op, so a
 * request is never recorded twice. A long request records nothing until one of the two events: there is no
 * timer.
 */
export function createUsageLogMiddleware(
  buffer: UsageLogBuffer,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();
    let recorded = false;
    const record = (aborted: boolean): void => {
      if (recorded) return;
      recorded = true;
      try {
        const row = buildUsageRow(req, res, startNs, Date.now(), aborted);
        if (row !== null) buffer.push(row);
      } catch {
        /* never reaches the client */
      }
    };
    res.once('finish', () => record(false));
    // `close` after a completed response is a no-op (`finish` already recorded); without `finish` the
    // connection died first.
    res.once('close', () => record(!res.writableFinished));
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
