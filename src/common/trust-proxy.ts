import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
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

/** `TRUST_PROXY` cannot be used; the message names the variable and says what to do. */
export class TrustProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustProxyConfigError';
  }
}

// ─── what a TRUST_PROXY list covers ───────────────────────────────────────

type Family = 4 | 6;
interface Range {
  token: string;
  family: Family;
  /** First address and number of addresses. */
  start: bigint;
  size: bigint;
}

const KEYWORDS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

function ipToBigInt(ip: string, family: Family): bigint {
  if (family === 4) {
    return ip
      .split('.')
      .reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
  }
  let text = ip.split('%')[0].toLowerCase();
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = ipToBigInt(tail[2], 4);
    text = `${tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const h: string[] = head === '' ? [] : head.split(':');
  const r: string[] = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros: string[] = Array.from(
    { length: 8 - h.length - r.length },
    () => '0',
  );
  const groups: string[] = rest === undefined ? h : [...h, ...zeros, ...r];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** `a.b.c.d/24`, `::1`, `10.0.0.1`, or null when the token is not an address (or CIDR) we can measure. */
function parseRange(token: string): Range | 'invalid' | null {
  const slash = token.indexOf('/');
  const addr = slash < 0 ? token : token.slice(0, slash);
  const family = isIP(addr);
  if (family === 0) return 'invalid';
  const bits = family === 4 ? 32 : 128;
  let prefix = bits;
  if (slash >= 0) {
    const p = token.slice(slash + 1);
    if (/^\d{1,3}$/.test(p)) prefix = Number(p);
    else if (family === 4 && isIP(p) === 4)
      return null; // `10.0.0.0/255.0.0.0`
    else return 'invalid';
    if (prefix > bits) return 'invalid';
  }
  const size = 1n << BigInt(bits - prefix);
  const base = ipToBigInt(addr, family as Family);
  // `::ffff:10.0.0.0/104`: an IPv4 range written the way a dual-stack socket reports it.
  if (family === 6 && prefix >= 96 && base >> 32n === 0xffffn) {
    const v4 = base & 0xffffffffn;
    return { token, family: 4, start: v4 - (v4 % size), size };
  }
  return {
    token,
    family: family as Family,
    start: base - (base % size),
    size,
  };
}

/** Addresses that are not public: private, loopback, link-local, CGNAT, multicast / reserved. */
const NON_PUBLIC: Record<Family, Array<[bigint, bigint]>> = (() => {
  const blocks = (cidrs: string[]): Array<[bigint, bigint]> =>
    cidrs.map((c) => {
      const r = parseRange(c) as Range;
      return [r.start, r.start + r.size] as [bigint, bigint];
    });
  return {
    4: blocks([
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '224.0.0.0/3',
    ]),
    6: blocks(['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']),
  };
})();

/** How many addresses of `r` are public (the non-public blocks are disjoint). */
function publicCount(r: Range): bigint {
  const end = r.start + r.size;
  let inside = 0n;
  for (const [from, to] of NON_PUBLIC[r.family]) {
    const lo = from > r.start ? from : r.start;
    const hi = to < end ? to : end;
    if (hi > lo) inside += hi - lo;
  }
  return r.size - inside;
}

/** A range with this many public addresses or more is "the Internet", not a proxy network. */
const TOO_WIDE: Record<Family, bigint> = { 4: 1n << 24n, 6: 1n << 104n };

export interface TrustProxyCheck {
  /** Reasons the value cannot be used (the process must not start). */
  errors: string[];
  /** Ranges that trust public addresses without being "the Internet". */
  warnings: string[];
}

/**
 * Looks at a comma separated `TRUST_PROXY` list: every entry must be `loopback` / `linklocal` /
 * `uniquelocal`, an address or a CIDR range (Express would stop with `TypeError: invalid IP
 * address`, which does not say which variable); and a range that covers PUBLIC addresses is flagged:
 * `0.0.0.0/1,128.0.0.0/1` (together, all of IPv4) makes Express believe `X-Forwarded-For` from every
 * client on the Internet, so every limit by IP and every audit event takes the address the client
 * writes. Under 2^24 public addresses (a /8; a CDN publishes its ranges as /20s and /13s) it is a
 * warning, at or over it, an error.
 */
export function checkTrustProxy(value: string): TrustProxyCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens = value.split(',').filter((t) => t !== '');
  const wide: Record<Family, bigint> = { 4: 0n, 6: 0n };
  const publicTokens: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (KEYWORDS[lower] !== undefined) continue;
    const r = parseRange(token);
    if (r === 'invalid') {
      errors.push(
        `TRUST_PROXY: "${token.slice(0, 64)}" is not valid. Use a number of hops, "loopback", "linklocal", "uniquelocal", an IP address or a CIDR range (comma separated), e.g. TRUST_PROXY=loopback,172.30.212.0/28.`,
      );
      continue;
    }
    if (r === null) continue; // an IPv4 netmask form: Express checks it
    const pub = publicCount(r);
    if (pub > 0n) {
      publicTokens.push(token);
      wide[r.family] += pub;
    }
  }
  if (errors.length > 0) return { errors, warnings };
  if (wide[4] >= TOO_WIDE[4] || wide[6] >= TOO_WIDE[6]) {
    errors.push(
      `TRUST_PROXY (${publicTokens.join(', ').slice(0, 200)}) covers a huge part of the public Internet: the backend would believe X-Forwarded-For from ANY client, so every rate limit by IP and every audit event would take the address the client writes. Name only the network of the proxy in front of this server (docs/deployment.md 17.8).`,
    );
  } else if (publicTokens.length > 0) {
    warnings.push(
      `TRUST_PROXY includes public addresses (${publicTokens.join(', ').slice(0, 200)}): the backend believes X-Forwarded-For from every host in those ranges. That is right only if they are your proxy / CDN (published ranges); a private network of the proxy is safer (docs/deployment.md 17.8).`,
    );
  }
  return { errors, warnings };
}

/**
 * Sets Express' `trust proxy` from `TRUST_PROXY`. An invalid value or a range that trusts the
 * Internet stops the start with a message that names the variable; a range with public addresses
 * is a WARN.
 */
export function applyTrustProxy(
  app: NestExpressApplication,
  raw: string | undefined | null,
): void {
  const value = resolveTrustProxy(raw);
  if (typeof value === 'string') {
    const { errors, warnings } = checkTrustProxy(value);
    if (errors.length > 0) throw new TrustProxyConfigError(errors[0]);
    for (const w of warnings) new Logger('Bootstrap').warn(w);
  }
  try {
    app.set('trust proxy', value);
  } catch (err) {
    throw new TrustProxyConfigError(
      `TRUST_PROXY=${String(raw).slice(0, 64)} was rejected by Express: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
