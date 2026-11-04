import { BlockList, isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Story 20.5 follow-up: `trust proxy` fails SILENTLY. With the proxy on an address that is not
 * trusted (Next and Nest in different containers, `TRUST_PROXY` left at its `loopback` default),
 * Express ignores `X-Forwarded-For` and every client becomes the proxy's address: one throttle
 * bucket for the whole site (5 anonymous failures lock the real admin out) and the proxy IP in
 * every audit event. Nothing errors. Two warnings, neither with an address in it (no PII):
 *
 * 1. At boot (`proxyStartupWarning`): production, `TRUST_PROXY` not set and the server not bound
 *    to loopback only. The default `loopback` is only right when every hop is on this host.
 * 2. At run time (`applyClientIpMonitor`): half of the last 100 requests that EXPECT the real client
 *    address have a `req.ip` that is a private address, or an `X-Forwarded-For` that was ignored
 *    (`req.ip` is the socket peer). One WARN, then silence for a cool-down, so a flood cannot fill
 *    the log. It looks at a WINDOW, not a streak (a health check or a request that is fine in the
 *    middle of the bad ones used to reset a streak and hide the problem), and it skips the routes
 *    that never carry the client address (QA round 3): the public cached reads Next calls without
 *    forwarding it (`/fx/current`, `/legal/current-versions`: 60 of them used to raise the warning
 *    on a correct TRUST_PROXY), the health checks and the Stripe webhook (the caller is Stripe, not
 *    a visitor).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackOnlyHost(host: string | undefined | null): boolean {
  const h = (host ?? '').trim().toLowerCase();
  return h !== '' && (LOOPBACK_HOSTS.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h));
}

export function proxyStartupWarning(opts: {
  nodeEnv: string | undefined;
  trustProxy: string | undefined | null;
  host: string | undefined | null;
}): string | null {
  if (opts.nodeEnv !== 'production') return null;
  if ((opts.trustProxy ?? '').trim() !== '') return null;
  if (isLoopbackOnlyHost(opts.host)) return null;
  return (
    'TRUST_PROXY is not set and the server is not bound to loopback only (set HOST=127.0.0.1 behind ' +
    'Nginx on the same host). The default "loopback" only believes X-Forwarded-For from 127.0.0.0/8 and ::1: ' +
    'behind a proxy in another container or host every client will look like the proxy (one shared rate ' +
    'limit, the proxy address in every audit event). Set TRUST_PROXY to the proxy network (docs/deployment.md 9.4).'
  );
}

const PRIVATE = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10], // CGNAT
    ['169.254.0.0', 16], // link-local
  ] as const) {
    b.addSubnet(net, prefix, 'ipv4');
  }
  b.addSubnet('fc00::', 7, 'ipv6'); // unique local
  b.addSubnet('fe80::', 10, 'ipv6'); // link-local
  return b;
})();

/** `::ffff:10.0.0.1` -> `10.0.0.1`. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export function isPrivateIp(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const v = unmap(ip);
  const kind = isIP(v);
  if (kind === 0) return false;
  return PRIVATE.check(v, kind === 4 ? 'ipv4' : 'ipv6');
}

/** The little of an Express request the diagnostics read (also what the tests pass). */
export interface ClientIpRequest {
  ip?: string;
  /** Express' `req.path` (no query string); `originalUrl` / `url` are read when it is absent. */
  path?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * Routes whose requests do not carry (or do not need) the client address: they say nothing about
 * whether `TRUST_PROXY` covers the proxy. Mounted under any prefix (`/api/v1/...`).
 */
const IP_AGNOSTIC_PATHS: readonly RegExp[] = [
  /\/health\/?$/i,
  /\/(?:livez|readyz|healthz|ping)\/?$/i,
  /\/fx\/current\/?$/i,
  /\/legal\/current-versions\/?$/i,
  /\/payments\/stripe\/webhook\/?$/i,
  /^\/uploads\//i,
];

/** True when this request is one where a correct setup puts the REAL client address in `req.ip`. */
export function expectsClientIp(req: ClientIpRequest): boolean {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '';
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  return !IP_AGNOSTIC_PATHS.some((re) => re.test(path));
}

export type SuspicionKind = 'private-ip' | 'forwarded-for-ignored';

/** Why this request looks like "the proxy was not believed", or null. Pure. */
export function suspicion(req: ClientIpRequest): SuspicionKind | null {
  const xff = req.headers['x-forwarded-for'];
  const peer = req.socket?.remoteAddress;
  if (
    xff !== undefined &&
    String(xff).trim() !== '' &&
    req.ip !== undefined &&
    peer !== undefined &&
    unmap(req.ip) === unmap(peer)
  ) {
    // The peer sent X-Forwarded-For and Express still answers with the peer itself: not believed.
    // A loopback peer is the local operator / health check, not a misconfiguration.
    if (!isLoopback(peer)) return 'forwarded-for-ignored';
  }
  if (isPrivateIp(req.ip)) return 'private-ip';
  return null;
}

function isLoopback(ip: string): boolean {
  const v = unmap(ip);
  return v === '::1' || /^127\./.test(v);
}

export interface ClientIpMonitorOptions {
  /** Suspicious requests, among the last `windowSize` that expect the client address, before the warning. */
  threshold?: number;
  /** How many of the latest requests that expect the client address are looked at. */
  windowSize?: number;
  /** Minimum time between two warnings. */
  cooldownMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  hasExplicitTrustProxy?: boolean;
}

export const MONITOR_THRESHOLD = 50;
export const MONITOR_WINDOW = 100;
export const MONITOR_COOLDOWN_MS = 10 * 60 * 1000;

export function createClientIpMonitor(opts: ClientIpMonitorOptions = {}) {
  const threshold = opts.threshold ?? MONITOR_THRESHOLD;
  const size = Math.max(opts.windowSize ?? MONITOR_WINDOW, threshold);
  const cooldown = opts.cooldownMs ?? MONITOR_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const logger = new Logger('ClientIpMonitor');
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  // Ring of the latest verdicts: 0 fine, 1 private-ip, 2 forwarded-for-ignored.
  const ring = new Uint8Array(size);
  const counts = [0, 0, 0];
  let next = 0;
  let seen = 0;
  let lastWarnAt = -Infinity;

  const state = {
    /** Suspicious requests among the window right now. */
    get suspicious() {
      return counts[1] + counts[2];
    },
    observe(req: ClientIpRequest): void {
      if (!expectsClientIp(req)) return;
      const s = suspicion(req);
      const verdict = s === null ? 0 : s === 'private-ip' ? 1 : 2;
      if (seen >= size) counts[ring[next]] -= 1;
      ring[next] = verdict;
      counts[verdict] += 1;
      next = (next + 1) % size;
      seen += 1;
      const bad = counts[1] + counts[2];
      if (bad < threshold || now() - lastWarnAt < cooldown) return;
      lastWarnAt = now();
      const kinds = [
        counts[1] > 0 ? 'private-ip' : null,
        counts[2] > 0 ? 'forwarded-for-ignored' : null,
      ].filter((k) => k !== null);
      warn(
        `${bad} of the last ${Math.min(seen, size)} requests that carry the client address resolved to ${kinds.join(' / ')} as the client address ` +
          `(${opts.hasExplicitTrustProxy ? 'TRUST_PROXY is set but does not cover the proxy' : 'TRUST_PROXY is not set'}). ` +
          'The proxy in front of this server is probably not trusted: every client shares one rate-limit bucket and ' +
          'audit events carry the proxy address. Set TRUST_PROXY to the proxy network (docs/deployment.md 9.4). ' +
          `Next warning in at least ${Math.round(cooldown / 60000)} min.`,
      );
    },
  };
  return state;
}

/** Mounted after `trust proxy` is set. Production only (see `main.ts`). */
export function applyClientIpMonitor(
  app: NestExpressApplication,
  opts: ClientIpMonitorOptions = {},
): void {
  const monitor = createClientIpMonitor(opts);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    try {
      monitor.observe(req);
    } catch {
      /* diagnostics never break a request */
    }
    next();
  });
}
