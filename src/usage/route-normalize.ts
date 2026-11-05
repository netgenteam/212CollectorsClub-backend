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
  // A router has a few hundred templates and they never change: the cleaning runs once per template.
  const hit = ROUTE_CACHE.get(p);
  if (hit !== undefined) return hit;
  const q = p.search(/[?#]/);
  const cut = (q >= 0 ? p.slice(0, q) : p).replace(CONTROL, '');
  const t = cut.length > ROUTE_MAX ? cut.slice(0, ROUTE_MAX) : cut;
  if (ROUTE_CACHE.size < 2_000) ROUTE_CACHE.set(p, t);
  return t;
}

const ROUTE_CACHE = new Map<string, string>();

/**
 * Requests that are never recorded (AC2): the health check, the PUBLIC static files, the API docs and
 * the usage-log queries themselves (a view that logs itself would feed itself; Story 20.7 round 2: the
 * query leaves an `USAGE_LOG_QUERIED` audit event instead, see `AdminReadTrailService`). Decided on the
 * matched template when there is one, and on the path (no query, lower case, doubled slashes collapsed)
 * when there is none, because Express routes case-insensitively and an unmatched request to
 * `/Uploads/Public/x` is still a static-file probe.
 *
 * Compared by whole SEGMENTS, never by string prefix: `/uploads/private/x` (proof of payment: a 404 or
 * a probe worth knowing about), `/api/docsXYZ` and `/api/v1/admin/audit/usagexyz` are NOT the
 * excluded paths and must leave a row.
 */
const EXCLUDED_SEGMENT_PREFIXES: readonly (readonly string[])[] = [
  ['api', 'v1', 'health'],
  // the one static-mounted directory (`PUBLIC_STATIC_PREFIX`); `uploads/private` is never served
  ['uploads', 'public'],
  ['api', 'docs'],
  ['api', 'docs-json'],
  ['api', 'docs-yaml'],
  ['api', 'v1', 'admin', 'audit', 'usage'],
];

/** The lower-case, percent-decoded segments of a path (doubled slashes collapse; `%2F` stays inside its segment). */
function segmentsOf(p: string): string[] {
  const out: string[] = [];
  for (const raw of p.split('/')) {
    if (raw === '') continue;
    let seg = raw;
    if (seg.includes('%')) {
      try {
        seg = decodeURIComponent(seg);
      } catch {
        /* a malformed escape stays as typed */
      }
    }
    out.push(seg.toLowerCase());
  }
  return out;
}

function isExcludedSegments(seg: readonly string[]): boolean {
  for (const prefix of EXCLUDED_SEGMENT_PREFIXES) {
    if (seg.length < prefix.length) continue;
    let all = true;
    for (let i = 0; i < prefix.length; i++) {
      if (seg[i] !== prefix[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** The path of `originalUrl` without query or fragment, lower case, doubled slashes collapsed. */
export function pathnameOf(originalUrl: string): string {
  const q = originalUrl.search(/[?#]/);
  const raw = q >= 0 ? originalUrl.slice(0, q) : originalUrl;
  return raw.toLowerCase().replace(/\/{2,}/g, '/');
}

/**
 * Allocation-free test for the common case (no `%` escape in the path): is `path` (up to a `?` / `#`, doubled
 * slashes skipped, ASCII case ignored) made of the segments of `prefix` followed by nothing, a `/`, a `?` or a
 * `#`? This runs for EVERY request, so it neither splits nor lower-cases the string.
 */
function startsWithSegments(path: string, prefix: readonly string[]): boolean {
  const n = path.length;
  let i = 0;
  for (const seg of prefix) {
    while (i < n && path.charCodeAt(i) === 47) i += 1; // '/'
    if (i + seg.length > n) return false;
    for (let j = 0; j < seg.length; j++) {
      let c = path.charCodeAt(i + j);
      if (c >= 65 && c <= 90) c += 32; // A-Z -> a-z
      if (c !== seg.charCodeAt(j)) return false;
    }
    i += seg.length;
    if (i < n) {
      const c = path.charCodeAt(i);
      if (c !== 47 && c !== 63 && c !== 35) return false; // '/', '?', '#'
    }
  }
  return true;
}

function isExcludedPath(path: string): boolean {
  // A percent escape can hide a character (`%76%31` is `v1`): the slow, decoding path handles those.
  if (path.includes('%')) {
    const q = path.search(/[?#]/);
    return isExcludedSegments(segmentsOf(q >= 0 ? path.slice(0, q) : path));
  }
  for (const prefix of EXCLUDED_SEGMENT_PREFIXES) {
    if (startsWithSegments(path, prefix)) return true;
  }
  return false;
}

export function isExcludedRequest(
  req: RouteLike,
  originalUrl: string,
): boolean {
  const tpl = req.route?.path;
  if (typeof tpl === 'string' && isExcludedPath(tpl)) return true;
  return isExcludedPath(originalUrl);
}
