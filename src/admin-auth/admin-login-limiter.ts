import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/api-exception.js';

export const ADMIN_LOGIN_RATE_LIMITED = 'ADMIN_LOGIN_RATE_LIMITED';

/** Defaults (overridable with env, see `AdminLoginLimiter`). */
export const ADMIN_LOGIN_DEFAULTS = {
  /** Failed logins per IP (any user name) inside the window. */
  maxFailuresPerIp: 20,
  /** Failed logins per (IP, user name) inside the window. */
  maxFailuresPerUser: 5,
  windowMs: 15 * 60 * 1000,
  /** `LOGIN_ADMIN_FAILED` events written to the chain per minute, whole instance. */
  maxFailedEventsPerMinute: 20,
  /** Writes in flight at once; beyond it the event is dropped (never queued). */
  maxFailedEventsInFlight: 4,
} as const;

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 20_000;

/**
 * Story 20.5 (AD-99, R4): bounds what an anonymous attacker can do through the admin login.
 *
 * Why: every failed login writes `LOGIN_ADMIN_FAILED` to the immutable chain under the global
 * chain-head lock, the table can never be pruned, and the login had no attempt limit.
 *
 * Three independent brakes, all in memory (like the app's other throttles, one instance per
 * environment, A101):
 *  1. per IP: `maxFailuresPerIp` failures per window -> 429, BEFORE any password hashing;
 *  2. per (IP, user name): `maxFailuresPerUser` failures per window -> 429. The pair, never
 *     the user name alone, so an attacker cannot lock the real admin out from elsewhere;
 *  3. an instance-wide budget of `LOGIN_ADMIN_FAILED` writes per minute and a cap of writes
 *     in flight: a distributed attack (many IPs) can no longer feed the chain faster than the
 *     budget (the dropped events are counted and logged, the 401 is unaffected).
 * The check depends only on counters keyed by what the client SENT, never on whether the user
 * exists, so it adds no enumeration oracle; the timing of the 401 keeps its dummy Argon2 verify.
 */
@Injectable()
export class AdminLoginLimiter {
  private readonly byIp = new Map<string, Bucket>();
  private readonly byPair = new Map<string, Bucket>();
  private eventsWindowStart = 0;
  private eventsInWindow = 0;
  private inFlight = 0;
  /** Events not written because of brake 3 (since boot). */
  droppedEvents = 0;

  constructor(private readonly config: ConfigService) {}

  private num(name: string, def: number): number {
    const v = Number(this.config.get<string>(name));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
  }

  private get windowMs(): number {
    return this.num('ADMIN_LOGIN_WINDOW_MS', ADMIN_LOGIN_DEFAULTS.windowMs);
  }

  static userKey(ip: string | null, identifier: string): string {
    const h = createHash('sha256')
      .update(identifier.trim().toLowerCase())
      .digest('hex')
      .slice(0, 24);
    return `${ip ?? 'unknown'}|${h}`;
  }

  /** Throws 429 when either failure counter is exhausted. Call BEFORE verifying the password. */
  assertAllowed(ip: string | null, identifier: string, now = Date.now()): void {
    const ipLeft = this.remaining(
      this.byIp,
      ip ?? 'unknown',
      this.num(
        'ADMIN_LOGIN_MAX_FAILURES_PER_IP',
        ADMIN_LOGIN_DEFAULTS.maxFailuresPerIp,
      ),
      now,
    );
    const userLeft = this.remaining(
      this.byPair,
      AdminLoginLimiter.userKey(ip, identifier),
      this.num(
        'ADMIN_LOGIN_MAX_FAILURES_PER_USER',
        ADMIN_LOGIN_DEFAULTS.maxFailuresPerUser,
      ),
      now,
    );
    const wait = Math.max(ipLeft ?? 0, userLeft ?? 0);
    if (wait > 0) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        ADMIN_LOGIN_RATE_LIMITED,
        'Too many failed login attempts. Try again later.',
        { retryAfterSeconds: Math.ceil(wait / 1000) },
      );
    }
  }

  /** ms until the bucket frees up when it is exhausted, else null. */
  private remaining(
    map: Map<string, Bucket>,
    key: string,
    max: number,
    now: number,
  ): number | null {
    const b = map.get(key);
    if (!b || b.resetAt <= now) return null;
    return b.count >= max ? b.resetAt - now : null;
  }

  recordFailure(ip: string | null, identifier: string, now = Date.now()): void {
    this.bump(this.byIp, ip ?? 'unknown', now);
    this.bump(this.byPair, AdminLoginLimiter.userKey(ip, identifier), now);
  }

  /** A good login clears the (IP, user) counter only; the per-IP one keeps counting. */
  recordSuccess(ip: string | null, identifier: string): void {
    this.byPair.delete(AdminLoginLimiter.userKey(ip, identifier));
  }

  private bump(map: Map<string, Bucket>, key: string, now: number): void {
    const b = map.get(key);
    if (!b || b.resetAt <= now) {
      if (map.size >= MAX_KEYS) this.sweep(map, now);
      map.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      b.count += 1;
    }
  }

  private sweep(map: Map<string, Bucket>, now: number): void {
    for (const [k, b] of map) if (b.resetAt <= now) map.delete(k);
    // Still full of live buckets (a flood of distinct keys): forget the oldest half.
    if (map.size >= MAX_KEYS) {
      let i = 0;
      for (const k of map.keys()) {
        map.delete(k);
        if (++i >= MAX_KEYS / 2) break;
      }
    }
  }

  /**
   * Brake 3. Returns a release function when this failed login may write its event, null when
   * the instance-wide budget or the in-flight cap says to drop it.
   */
  tryAcquireEventSlot(now = Date.now()): (() => void) | null {
    const perMinute = this.num(
      'AUDIT_LOGIN_FAILED_MAX_PER_MINUTE',
      ADMIN_LOGIN_DEFAULTS.maxFailedEventsPerMinute,
    );
    const maxInFlight = this.num(
      'AUDIT_LOGIN_FAILED_MAX_IN_FLIGHT',
      ADMIN_LOGIN_DEFAULTS.maxFailedEventsInFlight,
    );
    if (now - this.eventsWindowStart >= 60_000) {
      this.eventsWindowStart = now;
      this.eventsInWindow = 0;
    }
    if (this.eventsInWindow >= perMinute || this.inFlight >= maxInFlight) {
      this.droppedEvents += 1;
      return null;
    }
    this.eventsInWindow += 1;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight -= 1;
      }
    };
  }
}
