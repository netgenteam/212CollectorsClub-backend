import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Story 20.5 follow-up: which peers Express believes when they say "the client is X"
 * (`X-Forwarded-For`), i.e. what `req.ip` (throttles, audit events) is.
 *
 * Topology (docs/deployment.md 9.4, 11.3): Internet -> Nginx -> backend, and Internet -> Nginx ->
 * Next -> backend, every hop on LOOPBACK. Nginx appends the address it saw; Next forwards ONE
 * validated address (the one Nginx appended; `lib/utils/client-ip.ts` of the front end).
 *
 * Default `loopback` (127.0.0.0/8 and ::1), NOT a hop count:
 *  - `req.ip` is the first address, walking `X-Forwarded-For` from the right, that is NOT loopback.
 *    From Nginx: the address Nginx appended. From Next (or from Next through Nginx on the same
 *    host): the single address Next set, because the loopback addresses of Nginx/Next are skipped.
 *  - Whatever a client writes to the LEFT of that address is never read.
 *  - A connection that does NOT come from loopback (the port reachable from outside by mistake) is
 *    not trusted at all: `req.ip` is its socket address and its `X-Forwarded-For` is ignored.
 *    With a hop count (`1`) that header would be believed from anyone.
 * `TRUST_PROXY` overrides it (a hop count `1`, `loopback`, a CIDR list such as
 * `loopback,10.0.0.0/8`, or `false`) for a topology with the proxy on another address.
 */
export const DEFAULT_TRUST_PROXY = 'loopback';

export function resolveTrustProxy(
  raw: string | undefined | null,
): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === '') return DEFAULT_TRUST_PROXY;
  if (v.toLowerCase() === 'false') return false;
  if (/^\d{1,2}$/.test(v)) return Number(v);
  // `loopback, 10.0.0.0/8`: Express takes a comma separated list as is.
  return v.replace(/\s+/g, '');
}

export function applyTrustProxy(
  app: NestExpressApplication,
  raw: string | undefined | null,
): void {
  app.set('trust proxy', resolveTrustProxy(raw));
}
