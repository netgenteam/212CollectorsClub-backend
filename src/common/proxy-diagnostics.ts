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
 * 2. At run time (`applyClientIpMonitor`): many CONSECUTIVE requests whose `req.ip` is a private
 *    address, or whose `X-Forwarded-For` was ignored (`req.ip` is the socket peer). One WARN, then
 *    silence for a cool-down, so a flood cannot fill the log.
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
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
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
  /** Consecutive suspicious requests before the warning. */
  threshold?: number;
  /** Minimum time between two warnings. */
  cooldownMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  hasExplicitTrustProxy?: boolean;
}

export const MONITOR_THRESHOLD = 50;
export const MONITOR_COOLDOWN_MS = 10 * 60 * 1000;

export function createClientIpMonitor(opts: ClientIpMonitorOptions = {}) {
  const threshold = opts.threshold ?? MONITOR_THRESHOLD;
  const cooldown = opts.cooldownMs ?? MONITOR_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const logger = new Logger('ClientIpMonitor');
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  let streak = 0;
  let lastWarnAt = -Infinity;
  let kinds = new Set<SuspicionKind>();

  const state = {
    get streak() {
      return streak;
    },
    observe(req: ClientIpRequest): void {
      const s = suspicion(req);
      if (s === null) {
        streak = 0;
        kinds = new Set();
        return;
      }
      streak += 1;
      kinds.add(s);
      if (streak < threshold || now() - lastWarnAt < cooldown) return;
      lastWarnAt = now();
      warn(
        `${streak} consecutive requests resolved to ${[...kinds].join(' / ')} as the client address ` +
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
