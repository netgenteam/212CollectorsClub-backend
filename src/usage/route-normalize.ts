/**
 * Story 20.7 (AD-100, AC2/AC3): what a request is called in `Usage_Logs`. ONLY the route TEMPLATE the
 * router matched (`/api/v1/orders/lookup/:token`), never `req.originalUrl`, never the query string and
 * never the value of a parameter: a token, an order id or an `?idDoc=` can therefore not reach the table.
 */
export const UNMATCHED_ROUTE = '__unmatched__';
export const ROUTE_MAX = 200;

interface RouteLike {
  route?: { path?: unknown } | undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `req.route.path` when the router matched a plain string template; `'__unmatched__'` otherwise (404,
 * the static files, a handler that is not an Express route, a RegExp or array route). A template is at
 * most `ROUTE_MAX` characters and has no control characters; a `?` cannot occur in one, but whatever
 * follows one is cut anyway.
 */
export function normalizeRoute(req: RouteLike): string {
  const p = req.route?.path;
  if (typeof p !== 'string' || p.length === 0 || p[0] !== '/') {
    return UNMATCHED_ROUTE;
  }
  const q = p.search(/[?#]/);
  const t = (q >= 0 ? p.slice(0, q) : p).replace(CONTROL, '');
  return t.length > ROUTE_MAX ? t.slice(0, ROUTE_MAX) : t;
}

/**
 * Requests that are never recorded (AC2): the health check, the static files, the API docs and the
 * usage-log queries themselves (a view that logs itself would feed itself). Decided on the matched
 * template when there is one, and on the path (no query, lower case, doubled slashes collapsed) when
 * there is none, because Express routes case-insensitively and an unmatched request to
 * `/Uploads/x` is still a static-file probe.
 */
const EXCLUDED_PREFIXES = [
  '/api/v1/health',
  '/uploads/',
  '/api/docs',
  '/api/v1/admin/audit/usage',
];

function isExcludedPath(p: string): boolean {
  return EXCLUDED_PREFIXES.some((x) => p.startsWith(x));
}

export function pathnameOf(originalUrl: string): string {
  const q = originalUrl.search(/[?#]/);
  const raw = q >= 0 ? originalUrl.slice(0, q) : originalUrl;
  return raw.toLowerCase().replace(/\/{2,}/g, '/');
}

export function isExcludedRequest(
  req: RouteLike,
  originalUrl: string,
): boolean {
  const tpl = req.route?.path;
  if (typeof tpl === 'string' && isExcludedPath(tpl.toLowerCase())) return true;
  return isExcludedPath(pathnameOf(originalUrl));
}
